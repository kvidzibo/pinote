import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
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

test('an oversized backend that ignores SIGTERM is terminated before the queue is released', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinote-backend-stop-'));
  let pid: number | undefined;
  try {
    const module = join(root,'backend.mjs'), executable = join(root,'backend'), pidFile = join(root,'pid');
    await build({entryPoints:[fileURLToPath(new URL('../src/backend.ts',import.meta.url))],outfile:module,bundle:true,platform:'node',format:'esm'});
    const { Backend } = await import(pathToFileURL(module).href);
    await writeFile(executable,`#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('x'.repeat(8*1024*1024+1));setTimeout(()=>process.exit(0),10000);});`,{mode:0o700});
    const backend = new Backend(executable);
    const response = await backend.call('add',{text:'Do not release while alive',tag:null});
    pid = Number(await readFile(pidFile,'utf8'));
    assert.ok(!response.ok);
    if (!response.ok) assert.equal(response.error.code,'unknown');
    await backend.idle();
    assert.throws(()=>process.kill(pid!,0),{code:'ESRCH'});
  } finally { if (pid) { try { process.kill(pid,'SIGKILL'); } catch {} } await rm(root,{recursive:true,force:true}); }
});

test('oversized inherited output cannot strand the queue after the backend has exited', async () => {
  const root = await mkdtemp(join(tmpdir(),'pinote-backend-pipes-'));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const pidFile = join(root,'descendant');
  try {
    const module=join(root,'backend.mjs'), executable=join(root,'backend');
    await build({entryPoints:[fileURLToPath(new URL('../src/backend.ts',import.meta.url))],outfile:module,bundle:true,platform:'node',format:'esm'});
    const { Backend } = await import(pathToFileURL(module).href);
    const descendant=`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdout.on('error',()=>{});setTimeout(()=>process.stdout.write('x'.repeat(8*1024*1024+1)),100);setTimeout(()=>process.exit(0),2000);`;
    await writeFile(executable,`#!${process.execPath}\nrequire('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',1,2]}).unref();process.exit(0);`,{mode:0o700});
    const response=await Promise.race([new Backend(executable).call('add',{text:'Close inherited output safely',tag:null}),new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(new Error('Backend queue remained blocked by inherited pipes')),1000);})]);
    assert.ok(!response.ok);
    if (!response.ok) assert.equal(response.error.code,'unknown');
  } finally {
    clearTimeout(deadline);
    try { process.kill(Number(await readFile(pidFile,'utf8')),'SIGKILL'); } catch {}
    await rm(root,{recursive:true,force:true});
  }
});
