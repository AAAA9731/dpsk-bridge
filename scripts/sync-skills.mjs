import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const state = path.join(os.homedir(), '.dpsk-bridge');
if (process.platform !== 'win32') {
  console.log('Automatic skill synchronization currently requires Windows; copy skill/ into your host skill directory.');
} else if (fs.existsSync(state)) {
  for (const file of fs.readdirSync(state).filter(name => /^installed-skills(?:-codex|-generic-[A-F0-9]{16})?\.host\.json$/.test(name))) {
    const host = JSON.parse(fs.readFileSync(path.join(state, file), 'utf8'));
    if (!['Claude', 'Codex', 'Generic'].includes(host.target) || typeof host.root !== 'string' || !path.isAbsolute(host.root)) throw new Error(`Invalid host record: ${file}`);
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./install.ps1', import.meta.url)), '-SyncOnly', '-Target', host.target,
      ...(host.target === 'Generic' ? ['-SkillsDir', host.root] : [])];
    const result = spawnSync('powershell.exe', args, { windowsHide: true, stdio: 'inherit', timeout: 120000 });
    if (result.error || result.status !== 0) throw new Error(`Cannot synchronize ${host.target} skills: ${result.error?.message || result.status}`);
  }
}
