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
      let stdout = ''; let bytes = 0; let done = false;
      const finish = (result: Result<unknown>) => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
      const failed = (message: string) => finish({ protocol: 1, ok: false, error: { code: write ? 'unknown' : 'internal', message: write ? `${message} The operation may have succeeded; check saved state before retrying.` : message } });
      const child = spawn(this.executable, [], { env: this.env, stdio: ['pipe','pipe','pipe'], shell: false });
      const timer = setTimeout(() => { child.kill('SIGTERM'); failed('Backend response timed out.'); }, operation === 'kitty' ? 30000 : 10000);
      child.on('error', () => failed('Cannot start the configured Pinote backend.'));
      child.stdin.on('error', () => {});
      child.stderr.resume(); // Never send Python diagnostics or private paths into the renderer.
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 8 * 1024 * 1024) { child.kill('SIGTERM'); failed('Backend response exceeded the size limit.'); }
        else stdout += chunk;
      });
      child.on('close', () => {
        if (done) return;
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
