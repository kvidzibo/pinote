import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FieldAutomation, fieldAutomationPath } from '../mcp/field-events.ts';
import { ViewSchema } from '../remote/protocol.ts';

const exec = promisify(execFile);

test('HTTP binds watcher delivery and claims to the selected CLI and withholds on identity loss', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pinote-http-identity-'));
  const note = fileURLToPath(new URL('../../backend/bin/note', import.meta.url));
  const [a, b, alias, wrapper, gate, entered, unsupported, intake] = ['a', 'b', 'alias', 'note.cjs', 'gate', 'entered', 'unsupported', 'intake'].map(name => join(dir, name));
  const database = (data: string) => join(data, 'pinote/notes.db');
  const token = 'identity-test-secret-'.repeat(3);
  const env = { PINOTE_NOTE_COMMAND: wrapper, XDG_DATA_HOME: a, XDG_STATE_HOME: dir, PI_CODING_AGENT_DIR: dir };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const { startPinoteHttpServer } = await import('../mcp/http.ts');
  const runners: FieldAutomation[] = [];
  let service: Awaited<ReturnType<typeof startPinoteHttpServer>> | undefined;
  let client: Client | undefined;
  const run = async (data: string, ...args: string[]) => JSON.parse((await exec(note, ['--no-notify', ...args], {
    env: { ...process.env, XDG_DATA_HOME: data },
  })).stdout);
  const connect = async () => {
    service = await startPinoteHttpServer({ token, port: 0, logPath: join(dir, 'http.log') });
    client = new Client({ name: 'http-identity', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  };
  const disconnect = async () => { await client?.close(); await service?.close(); };
  const meta = (conversationId: string) => ({ 'native-ui/context': { conversationId, state: { selectedId: 1 } },
    'native-ui/features': { fieldEvents: true, fieldWatchers: true } });
  const view = async (owner: string) => {
    const response = await client!.readResource({ uri: 'pinote://ui', _meta: meta(owner) });
    return ViewSchema.parse(JSON.parse((response.contents[0] as { text: string }).text));
  };
  const current = async () => {
    const result = await client!.callTool({ name: 'get_current', arguments: {}, _meta: meta('reader') });
    return JSON.parse((result.content as { text: string }[])[0].text);
  };
  const owner = (data: string) => {
    const db = new DatabaseSync(fieldAutomationPath({ database: database(data) }));
    try { return db.prepare('SELECT context_id FROM owners WHERE task_id=1').get()?.context_id; } finally { db.close(); }
  };
  try {
    await symlink(b, alias);
    await writeFile(wrapper, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
(async () => {
  if (args.includes('--database-identity') && fs.existsSync(${JSON.stringify(unsupported)})) {
    process.on('SIGTERM', () => {});
    return setInterval(() => {}, 1000);
  }
  if (args.includes('field-events')) fs.writeFileSync(${JSON.stringify(intake)}, '');
  if (args.includes('get') && fs.existsSync(${JSON.stringify(gate)})) {
    fs.writeFileSync(${JSON.stringify(entered)}, '');
    while (fs.existsSync(${JSON.stringify(gate)})) await new Promise(r => setTimeout(r, 10));
  }
  process.stdout.write(require('node:child_process').execFileSync(${JSON.stringify(note)}, args, {
    env: {...process.env, XDG_DATA_HOME: ${JSON.stringify(alias)}}
  }));
})();
`, { mode: 0o700 });
    for (const [data, text] of [[a, 'Profile A'], [b, 'Profile B']]) {
      const handler = join(dir, `${text}.cjs`);
      await writeFile(handler, `#!${process.execPath}\nrequire('node:fs').readFileSync(0);\nconsole.log(JSON.stringify({state:'failed', notification:{key:'failed', message:${JSON.stringify(text + ' failure')}}}));\n`, { mode: 0o700 });
      const task = await run(data, 'agent', 'add', `--text=${text}`);
      assert.equal(task.id, 1);
      await run(data, 'agent', 'update', '1', '--expected-updated-at', task.updated_at, '--set-json', '{"Deploy":"dev"}');
      const runner = await FieldAutomation.open({ database: database(data), noteCommand: note,
        noteEnv: { ...process.env, XDG_DATA_HOME: data },
        watchers: () => [{ id: 'deploy', name: 'Deploy', enabled: true, bundled: false, path: handler }],
      });
      runners.push(runner);
      await runner.tick(); await runner.tick();
    }

    const legacy = join(dir, 'pinote/field-events', createHash('sha256').update(database(alias)).digest('hex').slice(0, 16), 'state.db');
    await mkdir(dirname(legacy), { recursive: true, mode: 0o700 });
    await writeFile(legacy, 'legacy', { mode: 0o600 });
    await assert.rejects(FieldAutomation.open({ database: database(b), lexicalDatabase: database(alias) }), /offline migration/);
    await connect();
    assert.deepEqual((await view('legacy-blocked')).fieldNotifications, []);
    assert.equal((await current()).text, 'Profile B');
    assert.equal(owner(b), undefined);
    assert.equal(owner(a), undefined);
    await disconnect();
    await rename(legacy, join(dir, 'legacy-backup'));

    await connect();
    const ready = await view('profile-b');
    assert.equal(ready.fieldNotifications?.[0]?.message, 'Profile B failure');
    assert.equal(owner(b), 'profile-b');
    assert.equal(owner(a), undefined);

    // Change the wrapper's XDG alias *after* identity verification but before
    // the selected task read. Both DBs have task #1 with the same field/value.
    await writeFile(gate, '');
    const reading = view('profile-b');
    void reading.catch(() => {}); // Prevent an unhandled rejection if setup fails while waiting for the gate.
    try {
      const deadline = Date.now() + 5000;
      for (;;) {
        try { await access(entered); break; } catch { /* Wait for task read. */ }
        assert.ok(Date.now() < deadline, 'task read reached the gate');
        await pause(10);
      }
      const replacement = join(dir, 'replacement');
      await symlink(a, replacement); await rename(replacement, alias);
    } finally { await rm(gate); }
    const retargeted = await reading;
    assert.deepEqual(retargeted.fieldNotifications, []);
    assert.equal(retargeted.watcherDiagnostics, undefined);
    const task = await current();
    assert.equal(task.text, 'Profile A');
    const edited = await client!.callTool({ name: 'update_current', _meta: meta('must-not-claim'), arguments: {
      expected_updated_at: task.updated_at, set: { Deploy: 'still works' },
    } });
    assert.ok(!edited.isError);
    assert.equal(owner(b), 'profile-b');
    assert.equal(owner(a), undefined);
    await assert.rejects(access(intake), { code: 'ENOENT' });
    await disconnect();

    await writeFile(unsupported, '');
    await connect();
    assert.deepEqual((await view('no-probe')).fieldNotifications, []);
    assert.equal((await current()).text, 'Profile A');
    assert.equal(owner(a), undefined);
  } finally {
    await disconnect();
    await Promise.all(runners.map(runner => runner.close()));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
