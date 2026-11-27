import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, symlinkSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { discoverPaths, jsonStringify, resolvePath, withDisplayLock, BusyError } from '../src/runtime.ts';

test('display lock excludes other writers and releases on close and writer death', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pinote-runtime-'));
  const paths = discoverPaths({ HOME: root });
  // Another process tries the same lock: 75 while held, 0 once released.
  const probe = () => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', `const {DatabaseSync}=require('node:sqlite');try{new DatabaseSync(${JSON.stringify(join(paths.data, 'display.lock'))}).exec('BEGIN EXCLUSIVE')}catch(e){process.exit(e.errcode===5?75:1)}`]).status;
  try {
    await withDisplayLock(paths, false, async () => {
      assert.equal(probe(), 75);
      await assert.rejects(withDisplayLock(paths, false, () => assert.fail('must not run')), BusyError);
    });
    assert.equal(probe(), 0);
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `import {withDisplayLock} from ${JSON.stringify(new URL('../src/runtime.ts', import.meta.url).href)}; await withDisplayLock(${JSON.stringify(paths)},false,()=>{console.log('locked');return new Promise(()=>{setInterval(()=>{},1000)});});`], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); child.once('exit', code => reject(new Error(`holder exited ${code}`))); });
    assert.equal(probe(), 75);
    child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve));
    assert.equal(probe(), 0);
    assert.equal(statSync(paths.data).mode & 0o777, 0o700);
    assert.equal(statSync(join(paths.data, 'display.lock')).mode & 0o777, 0o600);
    mkdirSync(join(root,'actual')); mkdirSync(join(root,'actual','nested'));
    symlinkSync(join(root,'actual','nested'),join(root,'link'));
    assert.equal(resolvePath(`${root}/link/../absent`),join(root,'actual','absent'));
    assert.equal(jsonStringify({ id: 9223372036854775807n }),'{"id":9223372036854775807}');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
