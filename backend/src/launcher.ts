import { readFileSync } from 'node:fs';
import { isMainThread, Worker, workerData } from 'node:worker_threads';
import { decodeIdentity, installCancellation, nulFields } from './runtime.ts';

function standaloneArgs(): string[] {
  const args = process.argv.slice(2);
  if (!args.some(arg => arg.includes('\ufffd'))) return args;
  // For both shebang wrappers and direct Node entry points, script arguments
  // are the unchanged suffix of execve's argv, not the Node flags or script name.
  const raw = Array.from(nulFields(readFileSync('/proc/self/cmdline'))).slice(-args.length);
  if (raw.length !== args.length) throw new Error('Cannot verify arguments.');
  const decoded = raw.map(arg => decodeIdentity(arg, 'Command-line argument'));
  if (decoded.some((arg, i) => arg !== args[i])) throw new Error('Cannot verify arguments.');
  return decoded;
}

// Keep signal handling responsive while node:sqlite, parsing or filesystem calls
// block the worker. SQLite and display.lock still belong to this one process.
export async function launch(main: (input?: Uint8Array) => Promise<number>, entry: string, inputLimit?: number): Promise<number> {
  if (!isMainThread) {
    installCancellation();
    return main(workerData.pinoteInput);
  }
  let argv: string[];
  try { argv = standaloneArgs(); }
  catch {
    process.stderr.write('Pinote could not verify command-line arguments as UTF-8.\n');
    return 2;
  }
  let input: Uint8Array | undefined;
  if (inputLimit !== undefined) {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > inputLimit) { input = Buffer.alloc(inputLimit + 1); break; }
      chunks.push(bytes);
    }
    input ??= Buffer.concat(chunks);
  }
  const state = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(new URL(entry), {
    workerData: { pinoteCancellation: state.buffer, pinoteInput: input }, argv,
    stdout: true, stderr: true,
  });
  worker.stdout.pipe(process.stdout, { end: false }); worker.stderr.pipe(process.stderr, { end: false });
  const stop = (code: number) => {
    Atomics.store(state, 0, code);
    worker.postMessage('cancel');
  };
  const interrupt = () => stop(130), terminate = () => stop(143);
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  let failed = false;
  worker.once('error', () => { failed = true; process.stderr.write('Pinote backend failed. Check saved state before retrying.\n'); });
  try {
    const code = await new Promise<number>(resolve => worker.once('exit', resolve));
    return Atomics.load(state, 0) || (failed ? 1 : code);
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
  }
}
