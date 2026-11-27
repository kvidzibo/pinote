import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Tests call the bridge as another frontend while the app writes. The bridge fails fast with `busy`
// before running the operation, so retry it like a frontend would; other failures stay fatal.
export const bridgeCaller = (command, args, env) => (operation, params) => {
  const deadline = Date.now() + 5000;
  for (;;) {
    const run = spawnSync(command, args, { env, input: JSON.stringify({ protocol: 1, operation, params }), encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 0, run.stderr);
    const response = JSON.parse(run.stdout);
    if (response.ok) return response.result;
    assert.ok(response.error?.code === 'busy' && Date.now() < deadline, run.stdout);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
};
