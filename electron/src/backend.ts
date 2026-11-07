import { spawn } from 'node:child_process';
import { PROTOCOL, type Operation, type Result } from './protocol.ts';
import { mutating, validEnvelope, validParams } from './security.ts';

export class Backend {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly executable: string, private env: NodeJS.ProcessEnv = process.env) {}
  idle() { return this.tail; }
  call(operation: Operation, params: unknown): Promise<Result<unknown>> {
    if (!validParams(operation, params)) return Promise.resolve({ protocol: PROTOCOL, ok: false, error: { code: 'invalid', message: 'Invalid backend request.' } });
    const run = this.tail.then(() => this.run(operation, params));
    this.tail = run.catch(() => {});
    return run;
  }
  private run(operation: Operation, params: unknown): Promise<Result<unknown>> {
    return new Promise(resolve => {
      const write = mutating(operation);
      let stdout = ''; let bytes = 0; let done = false; let stopping = '';
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: Result<unknown>) => { if (!done) { done = true; clearTimeout(timer); clearTimeout(killTimer); resolve(result); } };
      const failed = (message: string) => finish({ protocol: 1, ok: false, error: { code: write ? 'unknown' : 'internal', message: write ? `${message} The operation may have succeeded; check saved state before retrying.` : message } });
      const child = spawn(this.executable, [], { env: this.env, stdio: ['pipe','pipe','pipe'], shell: false });
      const closePipes = () => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); };
      const stop = (message: string) => {
        if (done || stopping) return;
        stopping = message;
        // exit can precede close when a descendant inherited the backend's output pipes.
        if (child.exitCode !== null || child.signalCode !== null) { closePipes(); return; }
        child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
      };
      const timer = setTimeout(() => stop('Backend response timed out.'), operation === 'kitty' ? 30000 : 10000);
      child.on('error', () => { if (child.pid) stop('Cannot stop the configured Pinote backend.'); else failed('Cannot start the configured Pinote backend.'); });
      child.on('exit', () => { if (stopping) closePipes(); });
      child.stdin.on('error', () => {});
      child.stderr.resume(); // Never send Python diagnostics or private paths into the renderer.
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (stopping || done) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > 8 * 1024 * 1024) stop('Backend response exceeded the size limit.');
        else stdout += chunk;
      });
      child.on('close', () => {
        if (done) return;
        if (stopping) { failed(stopping); return; }
        try {
          const response: unknown = JSON.parse(stdout);
          if (!validEnvelope(operation, response)) throw new Error('Invalid envelope');
          finish(response as Result<unknown>);
        } catch { failed('Backend returned an incomplete or invalid response.'); }
      });
      child.stdin.end(JSON.stringify({ protocol: PROTOCOL, operation, params }));
    });
  }
}
