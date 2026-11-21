import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { access, copyFile, mkdtemp, rename, rm, stat as fileStat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FieldAutomation, fieldAutomationPath } from '../mcp/field-events.ts';
import { ViewSchema } from '../remote/protocol.ts';

const exec = promisify(execFile);

test('HTTP binds watcher delivery and claims to the selected CLI and withholds on identity loss', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pinote-http-identity-'));
  const note = fileURLToPath(new URL('../../backend/bin/note', import.meta.url));
  const [a, b, selector, wrapper, gate, entered, unsupported, prohibited] = ['a', 'b', 'selector', 'note.cjs', 'gate', 'entered', 'unsupported', 'prohibited'].map(name => join(dir, name));
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
    'native-ui/features': { fieldEvents: true, fieldWatchers: true, watcherDiagnostics: true, footerNativeActions: true } });
  const view = async (owner: string) => {
    const response = await client!.readResource({ uri: 'pinote://ui', _meta: meta(owner) });
    return ViewSchema.parse(JSON.parse((response.contents[0] as { text: string }).text));
  };
  const agentContext = async () => JSON.stringify((await client!.readResource({ uri: 'pinote://agent-context', _meta: meta('reader') })).contents);
  const current = async (expected?: string) => {
    const result = await client!.callTool({ name: 'get_current', arguments: {}, _meta: meta('reader') });
    assert.equal(result._meta?.['pinote/database'], expected);
    const content = (result.content as { text: string }[])[0].text;
    assert.doesNotMatch(content, /pinoteTaskResponse|fileIdentity|lexicalDatabase/);
    return JSON.parse(content);
  };
  const owner = (data: string) => {
    const db = new DatabaseSync(fieldAutomationPath({ database: database(data) }));
    try { return db.prepare('SELECT context_id FROM owners WHERE task_id=1').get()?.context_id; } finally { db.close(); }
  };
  try {
    await writeFile(selector, b);
    await writeFile(wrapper, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
(async () => {
  if (args.includes('--database-identity') || args.includes('field-events')) {
    fs.writeFileSync(${JSON.stringify(prohibited)}, '');
    process.exit(1);
  }
  if (fs.existsSync(${JSON.stringify(gate)}) && args.includes(fs.readFileSync(${JSON.stringify(gate)}, 'utf8'))) {
    fs.writeFileSync(${JSON.stringify(entered)}, '');
    while (fs.existsSync(${JSON.stringify(gate)})) await new Promise(r => setTimeout(r, 10));
  }
  const env = {...process.env, XDG_DATA_HOME: fs.readFileSync(${JSON.stringify(selector)}, 'utf8')};
  if (fs.existsSync(${JSON.stringify(unsupported)})) {
    const action = fs.readFileSync(${JSON.stringify(unsupported)}, 'utf8');
    if (!action || args.includes(action)) delete env.PINOTE_TASK_RESPONSE;
  }
  process.stdout.write(require('node:child_process').execFileSync(${JSON.stringify(note)}, args, {env}));
})();
`, { mode: 0o700 });
    const open = (data: string, text: string) => FieldAutomation.open({ database: database(data), noteCommand: note,
      noteEnv: { ...process.env, XDG_DATA_HOME: data },
      watchers: () => [{ id: 'deploy', name: 'Deploy', enabled: true, bundled: false, path: join(dir, `${text}.cjs`) }],
    });
    for (const [data, text] of [[a, 'Profile A'], [b, 'Profile B']]) {
      const handler = join(dir, `${text}.cjs`);
      await writeFile(handler, `#!${process.execPath}\nrequire('node:fs').readFileSync(0);\nconsole.log(JSON.stringify({state:'failed', notification:{key:'failed', message:${JSON.stringify(text + ' failure')}}}));\n`, { mode: 0o700 });
      const task = await run(data, 'agent', 'add', `--text=${text}`);
      assert.equal(task.id, 1);
      await run(data, 'agent', 'update', '1', '--expected-updated-at', task.updated_at, '--set-json', '{"Deploy":"dev"}');
    }

    // Recreate an old wrapper watching B while keying state by the canonical
    // (not a symlink) service profile A. The old DB has no binding table.
    const from = fieldAutomationPath({ database: database(a) });
    const to = fieldAutomationPath({ database: database(b) });
    const legacyRunner = await open(b, 'Profile B');
    runners.push(legacyRunner);
    await legacyRunner.tick(); await legacyRunner.tick();
    const receipt = legacyRunner.notices(await run(b, 'agent', 'get', '1'), 'profile-b')[0];
    assert.equal(receipt.message, 'Profile B failure');
    await legacyRunner.close();
    let db = new DatabaseSync(to);
    try { db.exec('DROP TABLE fw_database'); } finally { db.close(); }
    await rename(dirname(to), dirname(from));
    await assert.rejects(open(a, 'Profile A'), /offline migration/);
    await assert.rejects(open(b, 'Profile B'), /offline migration/);
    await assert.rejects(access(to), { code: 'ENOENT' });
    await connect();
    assert.deepEqual((await view('legacy-blocked')).fieldNotifications, []);
    assert.equal((await current(database(b))).text, 'Profile B');
    assert.equal(owner(a), 'profile-b', 'ambiguous state was not modified');
    await disconnect();

    // Offline, the test knows B was the only writer. Move the whole directory
    // and approve that exact database. Receipts and owners must survive.
    await rename(dirname(from), dirname(to));
    db = new DatabaseSync(to);
    try {
      db.exec('BEGIN IMMEDIATE; CREATE TABLE fw_database (id INTEGER PRIMARY KEY CHECK(id=1), database_path TEXT NOT NULL, file_identity TEXT NOT NULL)');
      const stat = await fileStat(database(b), { bigint: true });
      db.prepare('INSERT INTO fw_database (id, database_path, file_identity) VALUES (1, ?, ?)').run(database(b), `${stat.dev}:${stat.ino}`);
      db.exec('COMMIT');
    } finally { db.close(); }
    await assert.rejects(access(from), { code: 'ENOENT' });
    for (const [data, text] of [[a, 'Profile A'], [b, 'Profile B']]) {
      const runner = await open(data, text);
      runners.push(runner);
      await runner.tick(); await runner.tick();
    }

    await connect();
    const ready = await view('profile-b');
    assert.equal(ready.fieldNotifications?.[0]?.message, 'Profile B failure');
    assert.equal(ready.fieldNotifications?.[0]?.id, receipt.id);
    assert.equal(ready.fieldNotifications?.[0]?.triggerWorker, true);
    assert.match(await agentContext(), /Profile B failure/);
    assert.equal(owner(b), 'profile-b');
    assert.equal(owner(a), undefined);

    // No symlink retarget or inode change: the wrapper directly chooses a
    // different XDG profile between the task list and selected-task read.
    const switched = async <T>(action: string, data: string, request: () => Promise<T>) => {
      await rm(entered, { force: true });
      await writeFile(gate, action);
      const pending = request();
      void pending.catch(() => {});
      try {
        const deadline = Date.now() + 5000;
        for (;;) {
          try { await access(entered); break; } catch { /* Wait for task operation. */ }
          assert.ok(Date.now() < deadline, 'task operation reached the gate');
          await pause(10);
        }
        await writeFile(selector, data);
      } finally { await rm(gate); }
      return pending;
    };
    const reading = switched('get', a, () => view('profile-b'));
    const retargeted = await reading;
    assert.deepEqual(retargeted.fieldNotifications, []);
    assert.equal(retargeted.watcherDiagnostics, undefined);
    assert.ok(retargeted.footer?.some(part => part.text.includes('Profile A')));
    assert.doesNotMatch(await agentContext(), /Profile [AB] failure/);
    assert.equal((await current(database(a))).text, 'Profile A');
    await disconnect();

    // Switch only after the update preflight read. Matching the submitted
    // revision on A lets the ordinary write succeed; it must not claim B.
    await writeFile(selector, b);
    await connect();
    assert.equal((await view('profile-b')).fieldNotifications?.length, 1);
    const task = await run(a, 'agent', 'get', '1');
    const edited = await switched('update', a, () => client!.callTool({ name: 'update_current', _meta: meta('must-not-claim'), arguments: {
      expected_updated_at: task.updated_at, set: { Deploy: 'still works' },
    } }));
    assert.ok(!edited.isError);
    assert.equal((await run(a, 'agent', 'get', '1')).agent_notes.Deploy, 'still works');
    assert.equal(owner(b), 'profile-b');
    assert.equal(owner(a), undefined);
    await assert.rejects(access(prohibited), { code: 'ENOENT' });
    await disconnect();

    // The selected task read alone is not proof for a separate start. If
    // that operation returns old-format JSON, it can select but not claim.
    await writeFile(selector, b);
    await writeFile(unsupported, 'start');
    await connect();
    const selectMeta = meta('new-owner');
    const selectedBefore = await view('profile-b');
    assert.equal(selectedBefore.fieldNotifications?.[0]?.id, receipt.id);
    const select = async () => {
      const before = (await client!.readResource({ uri: 'pinote://ui', _meta: selectMeta })).contents[0];
      const { revision } = ViewSchema.parse(JSON.parse((before as { text: string }).text));
      return (await client!.request({ method: 'native-ui/action', params: { uri: 'pinote://ui', action: 'select:1', revision, _meta: selectMeta } }, z.object({ view: ViewSchema }))).view;
    };
    assert.deepEqual((await select()).fieldNotifications, []);
    assert.equal(owner(b), 'profile-b');
    await rm(unsupported);
    assert.equal((await select()).fieldNotifications?.[0]?.id, receipt.id);
    assert.equal(owner(b), 'new-owner');

    const replacement = join(dir, 'replacement.db');
    await copyFile(database(b), replacement);
    await rename(replacement, database(b));
    assert.deepEqual((await view('new-owner')).fieldNotifications, []);
    assert.equal((await current(database(b))).text, 'Profile B');
    assert.equal(owner(b), 'new-owner');
    await disconnect();

    await writeFile(selector, a);
    await writeFile(unsupported, '');
    await connect();
    assert.deepEqual((await view('legacy-cli')).fieldNotifications, []);
    assert.equal((await current()).text, 'Profile A');
    assert.equal(owner(a), undefined);
    assert.equal((await view('legacy-cli')).watcherDiagnostics, undefined);
    await assert.rejects(access(prohibited), { code: 'ENOENT' });
  } finally {
    await disconnect();
    await Promise.all(runners.map(runner => runner.close()));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
