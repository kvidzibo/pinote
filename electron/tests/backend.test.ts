import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

test('incomplete mutation success is an unknown outcome, never a confirmed save', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinote-backend-response-'));
  try {
    const module = join(root, 'backend.mjs');
    await build({ entryPoints:[fileURLToPath(new URL('../src/backend.ts', import.meta.url))], outfile:module, bundle:true, platform:'node', format:'esm' });
    const { Backend } = await import(pathToFileURL(module).href);
    const executable = join(root, 'backend');
    for (const result of [null, {}, { changed: true }]) {
      await writeFile(executable, `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(JSON.stringify({protocol:1,ok:true,result}))}));`, { mode: 0o700 });
      const response = await new Backend(executable).call('add', { text:'Preserve this draft', tag:null });
      assert.ok(!response.ok);
      if (!response.ok) assert.equal(response.error.code, 'unknown');
    }
  } finally { await rm(root, { recursive:true, force:true }); }
});
