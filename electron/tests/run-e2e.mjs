// Runs the end-to-end suites concurrently, each on its own Xvfb server and private D-Bus session.
// They wait on application timers rather than the CPU, so parallel runs divide the wall time.
// E2E_SCREEN sets the screen (default 1280x900x24), E2E_JOBS the number of concurrent suites.
// Extra arguments run only `tests/e2e.mjs` with them, e.g. `--handoff-only` or `--part=2`.
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';

const extra = process.argv.slice(2);
const suites = extra.length ? [['tests/e2e.mjs', ...extra]] : [
  // Longest first, so the slowest suite never waits for a free slot.
  ['tests/e2e.mjs', '--part=1'], ['tests/e2e.mjs', '--part=2'], ['tests/e2e.mjs', '--part=3'],
  ['tests/watchers-e2e.mjs'], ['tests/images-e2e.mjs'], ['tests/fields-e2e.mjs'],
];
const screen = process.env.E2E_SCREEN || '1280x900x24';
const jobs = Number(process.env.E2E_JOBS || Math.min(suites.length, availableParallelism()));
if (!Number.isInteger(jobs) || jobs < 1) throw new Error('E2E_JOBS must be a positive integer');
// A suite must never reach the live desktop's window manager or compositor.
const env = { ...process.env };
for (const name of ['I3SOCK', 'SWAYSOCK', 'WAYLAND_DISPLAY']) delete env[name];

const run = suite => new Promise(done => {
  const started = performance.now();
  const child = spawn('xvfb-run', ['-a', '-s', `-screen 0 ${screen}`, 'dbus-run-session', '--', process.execPath, ...suite], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', output = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  let finished = false;
  const finish = failure => {
    if (finished) return; // A failed spawn emits `error`, then `close`.
    finished = true;
    const name = suite.join(' '), seconds = ((performance.now() - started) / 1000).toFixed(1);
    // Passing suites print only their own messages; the session services' chatter is on stderr.
    process.stdout.write(failure ? `FAILED ${name} (${seconds} s, ${failure})\n${output}\n` : `ok ${name} (${seconds} s)\n${stdout}`);
    done(!failure);
  };
  child.on('error', error => finish(String(error)));
  child.on('close', (code, signal) => finish(code === 0 ? '' : signal || `exit ${code}`));
});

const queue = [...suites];
let failed = false;
await Promise.all(Array.from({ length: jobs }, async () => { while (queue.length) if (!await run(queue.shift())) failed = true; }));
process.exitCode = failed ? 1 : 0;
