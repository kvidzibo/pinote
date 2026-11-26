#!/usr/bin/env node
// Runs one configured command for each event it receives. No shell: arguments are passed
// exactly as configured. Pinote's time limit kills the whole process group, command included.
import { spawn } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';

/** Resolves to `{}` after a zero exit; rejects on a missing/relative command or any other outcome. */
export function runCommand(event) {
  const command = event?.params?.command, rows = event?.params?.args ?? [];
  if (typeof command !== 'string' || !isAbsolute(command)) return Promise.reject(new Error('Command must be an absolute path'));
  if (!Array.isArray(rows) || rows.some((row) => typeof row?.value !== 'string')) return Promise.reject(new Error('Invalid arguments'));
  return new Promise((resolve, reject) => {
    // Output is discarded: the watcher's own output is limited, and it reports only success or failure.
    const child = spawn(command, rows.map((row) => row.value), { cwd: dirname(command), stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve({}) : reject(new Error('Command failed')));
  });
}

// import.meta.main needs Node 22.18/24.2; Node runs the entry point from its real path.
const main = import.meta.main ?? (() => { try { return import.meta.filename === realpathSync(process.argv[1]); } catch { return false; } })();
if (main) {
  try {
    let input = '';
    // Decoded as one stream: a multibyte character can span two reads.
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('Input too large');
    }
    process.stdout.write(`${JSON.stringify(await runCommand(JSON.parse(input)))}\n`);
  } catch {
    process.stderr.write('Run command failed\n');
    process.exitCode = 1;
  }
}
