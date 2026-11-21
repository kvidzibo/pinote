import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { trustedCudaLibraryPath } from '../src/cuda-library-path.ts';

test('CUDA trust follows each link and rejects a writable link parent or library', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pinote-cuda-'));
  const lib = '/usr/local/cuda/lib64';
  const target = join(root, 'opt/toolkit/lib');
  const aliases = join(root, 'etc/alternatives');
  try {
    for (const dir of [target, aliases, join(root, 'usr/local')]) await fs.mkdir(dir, { recursive: true, mode: 0o755 });
    await fs.symlink('/etc/alternatives/cuda', join(root, 'usr/local/cuda'));
    await fs.symlink('/opt/toolkit', join(aliases, 'cuda'));
    await fs.symlink('lib', join(root, 'opt/toolkit/lib64'));
    await fs.writeFile(join(target, 'libexample.so.1'), 'fixture', { mode: 0o644 });
    await fs.symlink('libexample.so.1', join(target, 'libexample.so'));
    // Simulate the system root/uid without privileges. Real modes, symlinks and
    // directory enumeration exercise the validator on machines without CUDA.
    const { lstat, readlink, statfs, opendir } = fs;
    t.mock.method(fs, 'lstat', async (path: string) => Object.assign(await lstat(join(root, path)), { uid: 0 }));
    t.mock.method(fs, 'readlink', (path: string) => readlink(join(root, path)));
    t.mock.method(fs, 'statfs', (path: string) => statfs(join(root, path)));
    t.mock.method(fs, 'opendir', (path: string) => opendir(join(root, path)));
    syncBuiltinESMExports();
    assert.equal(await trustedCudaLibraryPath(lib), true);
    assert.equal(await trustedCudaLibraryPath(`${lib}:`), false);
    await fs.chmod(aliases, 0o777);
    assert.equal(await trustedCudaLibraryPath(lib), false);
    await fs.chmod(aliases, 0o755);
    await fs.chmod(join(target, 'libexample.so.1'), 0o666);
    assert.equal(await trustedCudaLibraryPath(lib), false);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});
