# Select exactly one host for each install/update/uninstall operation.
param(
    [ValidateSet('Claude', 'Codex', 'Generic')][string]$Target,
    [string]$SkillsDir,
    [switch]$SyncOnly,
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
if (-not $Target) { throw 'Specify -Target Claude, Codex, or Generic. Generic also requires -SkillsDir.' }
if ($Target -eq 'Generic' -and (-not $SkillsDir -or -not [IO.Path]::IsPathRooted($SkillsDir))) { throw 'Generic requires an absolute -SkillsDir for your host.' }
if ($Target -ne 'Generic' -and $SkillsDir) { throw '-SkillsDir is only valid with -Target Generic.' }
$Repo = Split-Path -Parent $PSScriptRoot
$PkgName = 'dpsk-bridge'
$SkillsSrc = Join-Path $Repo 'skill'
$StateDir = Join-Path $env:USERPROFILE ".$PkgName"
$BackupDir = Join-Path $StateDir 'backups'
$Clients = @{
    Claude = @{ Root = (Join-Path $env:USERPROFILE '.claude\skills'); Manifest = (Join-Path $StateDir 'installed-skills.txt') }
    Codex = @{ Root = (Join-Path $env:USERPROFILE '.agents\skills'); Manifest = (Join-Path $StateDir 'installed-skills-codex.txt') }
}
if ($Target -eq 'Generic') {
    $genericPath = [IO.Path]::GetFullPath($SkillsDir).TrimEnd('\')
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $genericKey = ([BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($genericPath.ToLowerInvariant())))).Replace('-', '').Substring(0, 16) }
    finally { $hasher.Dispose() }
    $Clients.Generic = @{ Root = $genericPath; Manifest = (Join-Path $StateDir "installed-skills-generic-$genericKey.txt") }
}
# Copy old ownership manifests; keep original history/backups intact.
$LegacyStateDir = Join-Path $env:USERPROFILE '.claude-deepseek-bridge'
$MigrationMarker = Join-Path $StateDir 'legacy-manifests-migrated'
if ((Test-Path -LiteralPath $LegacyStateDir) -and -not (Test-Path -LiteralPath $MigrationMarker)) {
    foreach ($legacyManifest in Get-ChildItem -LiteralPath $LegacyStateDir -Filter 'installed-skills*.txt' -File) {
        $newManifest = Join-Path $StateDir $legacyManifest.Name
        if (-not (Test-Path -LiteralPath $newManifest)) {
            New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
            Copy-Item -LiteralPath $legacyManifest.FullName -Destination $newManifest
        }
    }
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    [IO.File]::WriteAllText($MigrationMarker, 'Legacy ownership manifests copied once. Original backups preserved.')
}
$Selected = @($Target)
$HostRecord = $Clients[$Target].Manifest -replace '\.txt$', '.host.json'
$script:changed = 0
function Say($tag, $msg, $color) { Write-Host ('  [{0}] ' -f $tag) -ForegroundColor $color -NoNewline; Write-Host $msg }
function Ok($msg) { Say ' ok ' $msg 'DarkGray' }
function Did($msg) { Say 'done' $msg 'Green'; $script:changed++ }
function Warn($msg) { Say 'warn' $msg 'Yellow' }
function Section($msg) { Write-Host ''; Write-Host $msg -ForegroundColor Cyan }

function Backup($path, $label) {
    New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
    $suffix = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $bak = Join-Path $BackupDir ('{0}.{1}.bak' -f ($label -replace '[\\/:~]', '_'), $suffix)
    Copy-Item -LiteralPath $path -Destination $bak -Recurse -Force
    return $bak
}
function Get-InstalledSkills($client) {
    $manifest = $Clients[$client].Manifest
    if (Test-Path -LiteralPath $manifest) {
        foreach ($name in Get-Content -LiteralPath $manifest) {
            $name = $name.Trim()
            if (-not $name) { continue }
            if ($name -notmatch '^[a-z0-9][a-z0-9-]{0,63}$') { throw "Invalid skill name in $($manifest): $name" }
            $name
        }
    }
}
# Verify the exact destination and reject links before copying/removing a skill.
function Get-SkillPath($client, $name) {
    if ($name -notmatch '^[a-z0-9][a-z0-9-]{0,63}$') { throw "Invalid skill name: $name" }
    $root = [IO.Path]::GetFullPath($Clients[$client].Root).TrimEnd('\')
    $dst = [IO.Path]::GetFullPath((Join-Path $root $name))
    if (-not $dst.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Skill path escapes destination: $dst" }
    $ancestor = $dst
    while ($ancestor) {
        if (Test-Path -LiteralPath $ancestor) {
            $item = Get-Item -LiteralPath $ancestor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked skill path needs manual handling: $ancestor" }
        }
        $ancestor = Split-Path -Parent $ancestor
    }
    if (Test-Path -LiteralPath $dst) {
        foreach ($item in Get-ChildItem -LiteralPath $dst -Recurse -Force) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked skill content needs manual handling: $($item.FullName)" }
        }
    }
    return $dst
}
function Remove-Skill($client, $name) {
    $dst = Get-SkillPath $client $name
    if (Test-Path -LiteralPath $dst) {
        $bak = Backup $dst "$client-$name"
        Remove-Item -LiteralPath $dst -Recurse -Force
        Did "$client skill $name removed (backup: $bak)"
    }
}
function Sync-File($src, $dst, $label) {
    if (Test-Path -LiteralPath $dst) {
        $sourceBytes = [IO.File]::ReadAllBytes($src)
        $destinationBytes = [IO.File]::ReadAllBytes($dst)
        if ([Convert]::ToBase64String($sourceBytes) -eq [Convert]::ToBase64String($destinationBytes)) { Ok "$label up to date"; return }
        $bak = Backup $dst $label
        Copy-Item -LiteralPath $src -Destination $dst -Force
        Did "$label updated (backup: $bak)"
    } else {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
        Copy-Item -LiteralPath $src -Destination $dst -Force
        Did "$label installed"
    }
}
function Get-NpmPrefix {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm is required.' }
    $prefix = & npm prefix -g
    if ($LASTEXITCODE -ne 0 -or -not $prefix) { throw 'Cannot read npm global prefix.' }
    return ($prefix | Out-String).Trim()
}
function Test-BridgeLinked($prefix, $packageName = $PkgName) {
    $link = Join-Path $prefix "node_modules\$packageName"
    if (-not (Test-Path -LiteralPath $link)) { return $false }
    $item = Get-Item -LiteralPath $link -Force
    $linkedPath = if ($item.Target) { @($item.Target)[0] } else { $item.FullName }
    if (-not [IO.Path]::IsPathRooted($linkedPath)) { $linkedPath = Join-Path (Split-Path -Parent $link) $linkedPath }
    return [IO.Path]::GetFullPath($linkedPath).TrimEnd('\') -ieq [IO.Path]::GetFullPath($Repo).TrimEnd('\')
}
function Remove-LegacyShims($prefix) {
    foreach ($name in 'dsv', 'dsv.cmd', 'dsv.ps1') {
        $file = Join-Path $prefix $name
        if ((Test-Path -LiteralPath $file) -and ((Get-Content -LiteralPath $file -Raw) -match '\.dsh[\\/]+bin[\\/]+dsv\.mjs')) {
            $null = Backup $file "legacy-$name"
            Remove-Item -LiteralPath $file -Force
            Did "Removed legacy launcher $name"
        }
    }
}
function Remove-RenamedShims($prefix) {
    foreach ($name in 'dsb', 'dsb.cmd', 'dsb.ps1', 'dsv', 'dsv.cmd', 'dsv.ps1') {
        $file = Join-Path $prefix $name
        if ((Test-Path -LiteralPath $file) -and ((Get-Content -LiteralPath $file -Raw) -match 'node_modules[\\/]+claude-deepseek-bridge[\\/]+bin[\\/]+ds[bv]\.mjs')) {
            $null = Backup $file "renamed-$name"
            Remove-Item -LiteralPath $file -Force
            Did "Backed up old package launcher $name"
        }
    }
}
if ($Uninstall) {
    Section "Uninstall: $($Selected -join ', ')"
    foreach ($client in $Selected) { foreach ($name in @(Get-InstalledSkills $client)) { $null = Get-SkillPath $client $name } }
    foreach ($client in $Selected) {
        foreach ($name in @(Get-InstalledSkills $client)) { Remove-Skill $client $name }
        if (Test-Path -LiteralPath $Clients[$client].Manifest) { Remove-Item -LiteralPath $Clients[$client].Manifest -Force }
        if (Test-Path -LiteralPath $HostRecord) { Remove-Item -LiteralPath $HostRecord -Force }
    }
    $remaining = @(Get-ChildItem -LiteralPath $StateDir -Filter 'installed-skills*.txt' -File -ErrorAction SilentlyContinue | Where-Object { (Get-Content -LiteralPath $_.FullName | Where-Object { $_.Trim() }).Count })
    if ($remaining.Count) { Ok 'Another host is installed; keeping shared dsb / dsv commands.' }
    else {
        $prefix = Get-NpmPrefix
        if (Test-BridgeLinked $prefix) {
            & npm unlink -g $PkgName --ignore-scripts --no-fund --no-audit | Out-Host
            if ($LASTEXITCODE -ne 0) { throw "npm unlink failed (exit $LASTEXITCODE)." }
            Did 'Removed shared dsb / dsv commands.'
        } else { Ok 'No global link to this checkout; leaving other installations alone.' }
        Remove-LegacyShims $prefix
    }
    Ok 'dsh, credentials, MCP patches and job history are preserved.'
    return
}
Write-Host "dpsk-bridge: $($Selected -join ', ')" -ForegroundColor Cyan
Write-Host "Checkout: $Repo" -ForegroundColor DarkGray
Section '1/3 Dependencies and source checks'
if (-not $SyncOnly) {
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js >= 24.9 is required.' }
$nodeVer = [version]((& node --version).TrimStart('v'))
if ($nodeVer -lt [version]'24.9.0') { throw "Node.js >= 24.9 required by current dsh; found $nodeVer." }
Ok "Node.js $nodeVer"
$prefix = Get-NpmPrefix
Push-Location $Repo
try {
    & npm ci --ignore-scripts --no-fund --no-audit | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Cannot install locked bridge dependencies.' }
} finally { Pop-Location }
if (Get-Command dsh -ErrorAction SilentlyContinue) {
    $dshVer = (& dsh --version).Trim()
    Ok "dsh $dshVer"
    & node -e "const s=require(process.argv[1]); process.exit(s.valid(process.argv[2]) && s.gte(process.argv[2], '0.2.1-rc.2') ? 0 : 1)" (Join-Path $Repo 'node_modules/semver') $dshVer
    if ($LASTEXITCODE -ne 0) {
        & npm install -g '@deepseek-ai/dsh@latest' --no-fund --no-audit | Out-Host
        if ($LASTEXITCODE -ne 0) { throw 'Cannot update dsh to the required version.' }
        Did 'Updated dsh; existing configuration and credentials are preserved.'
    }
}
else {
    & npm install -g '@deepseek-ai/dsh@latest' --no-fund --no-audit | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Cannot install dsh.' }
    Did 'Installed dsh. Configure authentication before delegating.'
}
$installedDsh = (& dsh --version).Trim()
& node -e "const s=require(process.argv[1]); process.exit(s.valid(process.argv[2]) && s.gte(process.argv[2], '0.2.1-rc.2') ? 0 : 1)" (Join-Path $Repo 'node_modules/semver') $installedDsh
if ($LASTEXITCODE -ne 0) { throw "Installed dsh does not satisfy >=0.2.1-rc.2: $installedDsh" }
Push-Location $Repo
try { & npm run check | Out-Host; if ($LASTEXITCODE -ne 0) { throw 'Bridge source checks failed.' } }
finally { Pop-Location }
}
$repoSkills = @(Get-ChildItem -LiteralPath $SkillsSrc -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'SKILL.md') } | ForEach-Object Name)
if (-not $repoSkills.Count) { throw 'No skills found in this checkout.' }
foreach ($client in $Selected) {
    foreach ($name in @($repoSkills + @(Get-InstalledSkills $client) | Sort-Object -Unique)) { $null = Get-SkillPath $client $name }
}
Section '2/3 Skills'
foreach ($client in $Selected) {
    foreach ($name in $repoSkills) {
        $src = Join-Path $SkillsSrc $name
        $dst = Get-SkillPath $client $name
        foreach ($file in Get-ChildItem -LiteralPath $src -File -Recurse) {
            $rel = $file.FullName.Substring($src.Length).TrimStart('\')
            Sync-File $file.FullName (Join-Path $dst $rel) "$client/$name/$rel"
        }
    }
    foreach ($old in @(Get-InstalledSkills $client)) { if ($repoSkills -notcontains $old) { Remove-Skill $client $old } }
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    $want = ($repoSkills -join [Environment]::NewLine) + [Environment]::NewLine
    $manifest = $Clients[$client].Manifest
    if (-not (Test-Path -LiteralPath $manifest) -or (Get-Content -LiteralPath $manifest -Raw) -ne $want) {
        [IO.File]::WriteAllText($manifest, $want)
    }
    Ok "$client skills: $($Clients[$client].Root)"
    [IO.File]::WriteAllText($HostRecord, (@{ target = $Target; root = $Clients[$client].Root } | ConvertTo-Json))
}
if ($SyncOnly) { Ok 'Installed host skills synchronized.'; return }
Section '3/3 Shared commands'
Remove-LegacyShims $prefix
if ((Test-BridgeLinked $prefix) -and (Test-Path -LiteralPath (Join-Path $prefix 'dsv.cmd')) -and (Test-Path -LiteralPath (Join-Path $prefix 'dsb.cmd'))) {
    Ok 'dsb / dsv already linked to this checkout.'
} else {
    if (Test-BridgeLinked $prefix 'claude-deepseek-bridge') {
        & npm unlink -g claude-deepseek-bridge --ignore-scripts --no-fund --no-audit | Out-Host
        if ($LASTEXITCODE -ne 0) { throw 'Cannot unlink renamed package from this checkout.' }
    }
    Remove-RenamedShims $prefix
    Push-Location $Repo
    try {
        & npm link --offline --ignore-scripts --package-lock=false --no-fund --no-audit | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "npm link failed (exit $LASTEXITCODE)." }
    } finally { Pop-Location }
    if (-not (Test-BridgeLinked $prefix)) { throw 'npm link did not create the expected global link.' }
    Did 'Linked dsb / dsv to this checkout; keep this directory in place.'
}
foreach ($name in 'dsb', 'dsv') {
    if (-not (Test-Path -LiteralPath (Join-Path $prefix "$name.cmd"))) { throw "Missing global launcher: $name" }
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) { Ok "$($name): $($command.Source)" }
    else { Warn "$name is not on PATH; add $prefix to PATH or open a new terminal." }
}
Write-Host ''
if ($script:changed) { Write-Host "Complete: $($script:changed) changes. Reopen the host session if skills do not appear." -ForegroundColor Green }
else { Write-Host 'Everything is up to date.' -ForegroundColor Green }
Write-Host 'Delegate: dsb run --cwd <project> --brief <file>. Sessions: dsv. Usage: dsb stats.'
