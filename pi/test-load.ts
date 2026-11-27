import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { crc32, deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { ENTRY_TYPE, SCOPE } from './extension/session.ts';
import { createEventBus } from '@earendil-works/pi-coding-agent';

const root = dirname(fileURLToPath(import.meta.url));
test('default package loads through Pi and two sessions share real local notes', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'pinote-http-load-'));
  const original = { ...process.env };
  const entries: any[] = [], otherEntries: any[] = [];
  const notices: string[] = [];
  const extensions: any[] = [];
  const buses = new Map<any, ReturnType<typeof createEventBus>>();
  Object.assign(process.env, {
    PINOTE_NOTE_COMMAND: resolve(root, '../backend/bin/note'), PI_CODING_AGENT_DIR: join(temp, 'agent'),
    XDG_DATA_HOME: join(temp, 'data'), XDG_STATE_HOME: join(temp, 'state') });
  mkdirSync(join(temp, 'agent'));
  const event = async (extension: any, name: string, ctx: any, data = {}) => {
    const results = [];
    for (const handler of extension.handlers.get(name) ?? []) results.push(await handler(data, ctx));
    return results;
  };
  const context = (branch: any[], id: string) => ({ cwd: temp, mode: 'rpc', hasUI: false, isIdle: () => true,
    sessionManager: { getSessionFile: () => join(temp, `${id}.jsonl`), getSessionId: () => id, getBranch: () => branch },
    ui: { notify: (message: string) => notices.push(message) } });
  const ctx = context(entries, randomUUID()), otherCtx = context(otherEntries, randomUUID());
  try {
    const task = JSON.parse(execFileSync(process.env.PINOTE_NOTE_COMMAND!, ['--no-notify', 'agent', 'add', '--text=Shared task'], { encoding: 'utf8' }));
    entries.push({ type: 'custom', customType: ENTRY_TYPE, data: { scope: SCOPE, contextId: 'accepted-selection', state: { selectedId: task.id } } });
    const piEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
    const { loadExtensions } = await import(pathToFileURL(join(dirname(piEntry), 'core/extensions/loader.js')).href);
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.pi.extensions, ['./index.ts']);
    const load = async (branch: any[]) => {
      const bus = createEventBus();
      const loaded = await loadExtensions(manifest.pi.extensions.map((path: string) => join(root, path)), temp, bus);
      assert.deepEqual(loaded.errors, []);
      loaded.runtime.appendEntry = (customType: string, data: unknown) => branch.push({ type: 'custom', customType, data });
      const extension = loaded.extensions[0]; extensions.push(extension); buses.set(extension, bus); return extension;
    };
    const first = await load(entries), other = await load(otherEntries);
    await event(first, 'session_start', ctx); await event(other, 'session_start', otherCtx);
    assert.deepEqual([...first.commands.keys()], ['pinote']);
    assert.equal(first.tools.size, 9);
    const call = (extension: any, name: string, args: any, context: any) => extension.tools.get(`pinote_${name}`).definition.execute(name, args, undefined, undefined, context);
    const parsed = (result: any) => JSON.parse(result.content[0].text);
    assert.equal(parsed(await call(first, 'get_current', {}, ctx)).id, task.id);
    let queried: Promise<unknown> | undefined;
    buses.get(first)!.emit('pinote:query-current', { signal: new AbortController().signal, respond: (reply: any) => { queried = reply.result; } });
    assert.ok(queried, 'Sibling extensions can query the current task');
    assert.equal(parsed(await queried).id, task.id);
    assert.equal((await queried as any)._meta['pinote/database'], join(temp, 'data/pinote/notes.db'));
    assert.equal(parsed(await call(other, 'get_current', {}, otherCtx)), null);
    assert.equal(parsed(await call(other, 'get_task', { task_id: task.id }, otherCtx)).text, task.text);
    // A task's pasted image reaches the model as an image block, read through the real CLI.
    // Its base64 exceeds 4 MiB and it is wider than Pi shows, so it must arrive whole and scaled down.
    const chunk = (type: string, body: Buffer) => { const data = Buffer.concat([Buffer.from(type), body]), out = Buffer.alloc(body.length + 12); out.writeUInt32BE(body.length); data.copy(out, 4); out.writeUInt32BE(crc32(data), body.length + 8); return out; };
    const png = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), chunk('IHDR', Buffer.from([0, 0, 8, 152, 0, 0, 2, 8, 8, 2, 0, 0, 0])), chunk('IDAT', deflateSync(Buffer.alloc(520 * (1 + 2200 * 3)), { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
    const hash = createHash('sha256').update(png).digest('hex'), db = new DatabaseSync(join(temp, 'data/pinote/notes.db'));
    db.exec('CREATE TABLE IF NOT EXISTS images (hash TEXT PRIMARY KEY NOT NULL, mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, bytes BLOB NOT NULL, created_at TEXT NOT NULL)');
    db.prepare('INSERT INTO images VALUES (?,?,?,?,?,?)').run(hash, 'image/png', 2200, 520, png, '2026-01-01T00:00:00+00:00'); db.close();
    const image = (await call(other, 'get_image', { hash }, otherCtx)).content;
    assert.ok(png.length * 4 / 3 > 4 * 1024 * 1024);
    assert.match(image[0].text, /original 2200x520, displayed at 2000x473/);
    assert.equal(image[1].type, 'image'); assert.ok(image[1].data.length > 0 && image[1].data.length < png.length);
    assert.match((await call(other, 'get_image', { hash: '0'.repeat(64) }, otherCtx)).content[0].text, /not found/);
    await assert.rejects(call(other, 'propose', { title: 'x'.repeat(61) }, otherCtx), /title/);
    await call(other, 'propose', { title: 'Review task formatting', description: 'Preserve the full description.\n\n- Keep Markdown', tag: 'pinote' }, otherCtx);
    assert.equal(otherEntries.at(-1).data.state.proposal.text, 'Review task formatting\n\nPreserve the full description.\n\n- Keep Markdown');
    assert.equal(parsed(await call(other, 'get_current', {}, otherCtx)), null);
    const turnContext = async () => {
      const prompt = { systemPromptOptions: { sections: {} as Record<string, string> } };
      const [result] = await event(first, 'before_agent_start', ctx, prompt);
      const message = result?.message;
      assert.equal(message?.customType, 'pinote-context');
      assert.equal(message.display, false);
      const { service, warning, text } = JSON.parse(message.content);
      assert.equal(service, 'pinote');
      assert.match(warning, /UNTRUSTED TASK DATA.*not instructions or authorization/);
      return { instructions: prompt.systemPromptOptions.sections.pinote_remote, text };
    };
    const before = await turnContext();
    assert.match(before.instructions, /UNTRUSTED TASK DATA/);
    assert.ok(!before.instructions.includes(task.text));
    assert.doesNotMatch(before.instructions, /Continue elsewhere/);
    assert.ok(before.text.includes(task.text));
    assert.doesNotMatch(before.text, /Continue elsewhere/);

    const updated = parsed(await call(first, 'update_current', { expected_updated_at: task.updated_at, set: { Next: 'Continue elsewhere' } }, ctx));
    assert.equal(updated.agent_notes.Next, 'Continue elsewhere');
    assert.equal(parsed(await call(other, 'get_task', { task_id: task.id }, otherCtx)).agent_notes.Next, 'Continue elsewhere');
    await assert.rejects(call(first, 'update_current', { expected_updated_at: task.updated_at, set: { Next: 'Stale' } }, ctx));
    const after = await turnContext();
    assert.equal(after.instructions, before.instructions, 'A task update must not change the system instructions');
    assert.ok(after.text.includes(task.text));
    assert.match(after.text, /"Next":"Continue elsewhere"/);
    process.env.PINOTE_NOTE_COMMAND = join(temp, 'missing-note');
    const unavailable = await turnContext();
    assert.equal(unavailable.instructions, before.instructions, 'An unavailable CLI must not change the system instructions');
    assert.match(unavailable.text, /UNAVAILABLE/);
    assert.ok(!unavailable.text.includes(task.text));
    assert.doesNotMatch(unavailable.text, /Continue elsewhere/);
  } finally {
    for (let i = 0; i < extensions.length; i++) await event(extensions[i], 'session_shutdown', i === 0 ? ctx : otherCtx);
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    rmSync(temp, { recursive: true, force: true });
  }
});
