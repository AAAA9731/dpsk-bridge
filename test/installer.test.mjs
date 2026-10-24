import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('generic host synchronization backs up files and records only the selected host', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const destination = path.join(root, 'custom-host', 'skills');
  fs.mkdirSync(path.join(destination, 'deepseek-delegate'), { recursive: true });
  fs.writeFileSync(path.join(destination, 'deepseek-delegate', 'SKILL.md'), 'previous custom content');
  const script = fileURLToPath(new URL('../scripts/install.ps1', import.meta.url));
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Target', 'Generic', '-SkillsDir', destination, '-SyncOnly'];
  const run = () => spawnSync('powershell.exe', args, { encoding: 'utf8', timeout: 30000, env: { ...process.env, USERPROFILE: root } });
  const first = run(); assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(fs.readFileSync(path.join(destination, 'deepseek-delegate', 'SKILL.md'), 'utf8'), /name: deepseek-delegate/);
  assert.ok(fs.existsSync(path.join(destination, 'dsh-mcp', 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'skills'))); assert.ok(!fs.existsSync(path.join(root, '.agents', 'skills')));
  const state = path.join(root, '.dpsk-bridge');
  const host = fs.readdirSync(state).find(name => name.endsWith('.host.json'));
  assert.equal(fs.realpathSync.native(JSON.parse(fs.readFileSync(path.join(state, host), 'utf8')).root), fs.realpathSync.native(destination));
  const backups = fs.readdirSync(path.join(state, 'backups'));
  assert.ok(backups.some(file => fs.readFileSync(path.join(state, 'backups', file), 'utf8') === 'previous custom content'));
  const second = run(); assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(fs.readdirSync(path.join(state, 'backups')).length, backups.length);
});
