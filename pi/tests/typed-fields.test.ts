import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectEngine } from './host.ts';
import { parseFooterConfig } from '../footer-config.ts';
import { fieldItems, fieldText, fieldType } from '../field-values.ts';
import { fieldSettings, saveFieldSettings } from '../watcher-host.ts';

async function profile(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'pinote-typed-fields-'));
  const names = ['PINOTE_NOTE_COMMAND', 'PI_CODING_AGENT_DIR', 'XDG_DATA_HOME', 'XDG_STATE_HOME'], previous = names.map((name) => process.env[name]);
  Object.assign(process.env, { PINOTE_NOTE_COMMAND: fileURLToPath(new URL('../../backend/bin/note', import.meta.url)), PI_CODING_AGENT_DIR: dir, XDG_DATA_HOME: dir, XDG_STATE_HOME: dir });
  t.after(async () => {
    names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('a field type is validated, kept, and defaults by name', () => {
  const { fields } = parseFooterConfig({ footer: { fields: ['PRs', 'Worktrees', 'Notes', { name: 'Links', type: 'list' }, { name: 'PR', type: 'text' }] } });
  assert.deepEqual(fields!.map((field) => [field.type, fieldType(field)]),
    [[undefined, 'unique-list'], [undefined, 'unique-list'], [undefined, 'text'], ['list', 'list'], ['text', 'text']]);
  for (const type of ['array', '', null, 1]) assert.throws(() => parseFooterConfig({ footer: { fields: [{ name: 'Notes', type }] } }), /type must be text, list or unique-list/);
  assert.deepEqual(fieldItems(' a \r\n\nb\na '), ['a', 'b', 'a']);
  assert.deepEqual(fieldItems(['a\nb', ' a '], true), ['a', 'b']);
  assert.equal(fieldText(['a', 'b']), 'a\nb');
});

test('the desktop reads every definition with effective values and saves only the footer', async (t) => {
  const dir = await profile(t), path = join(dir, 'pi-note.json');
  await writeFile(path, JSON.stringify({ handoffPrompt: 'Keep', footer: { maxFields: 2, fields: [{ name: 'Notes', enabled: false }] } }));
  const settings = fieldSettings();
  assert.deepEqual(settings.footer.fields.map(({ name, type, enabled, saved }) => [name, type, enabled, saved]),
    [['Notes', 'text', false, true], ['Worktrees', 'unique-list', false, false], ['PRs', 'unique-list', false, false]]);
  assert.match(settings.footer.fields[1].instructions, /worktree root/);
  assert.deepEqual([settings.footer.maxFields, settings.footer.bar, settings.footer.fieldsDefined], [2, null, true]);
  const footer = { ...settings.footer, bar: ['Links'], fields: [{ name: 'Links', label: 'Links', type: 'list', enabled: true, link: true, format: '<value>', instructions: '' }] };
  assert.throws(() => saveFieldSettings({ ...footer, fields: [{ name: 'Links', type: 'set' }] }, settings.raw), /type must be/);
  const raw = saveFieldSettings(footer, settings.raw);
  assert.equal(await readFile(path, 'utf8'), raw);
  assert.deepEqual(JSON.parse(raw), { handoffPrompt: 'Keep', footer: { titleWidth: 60, fieldWidth: 60, maxFields: 2, fields: footer.fields, bar: ['Links'] } });
  assert.throws(() => saveFieldSettings(footer, settings.raw), /changed while settings were open/);
  assert.equal(fieldSettings().footer.fields[0].type, 'list');
});

test('update_current applies each field type and converts saved text to a list on the next write', async (t) => {
  const dir = await profile(t);
  await writeFile(join(dir, 'pi-note.json'), JSON.stringify({ footer: { fields: [{ name: 'Notes' }, { name: 'Links', type: 'list' }, { name: 'PRs' }] } }));
  const client = connectEngine();
  t.after(() => client.close());
  let state: Record<string, unknown> = {};
  const meta = () => ({ 'native-ui/context': { conversationId: 'conversation', piSessionId: '12345678-1234-4234-8234-123456789012', state } });
  const view = JSON.parse(await client.readView(meta()));
  state = (await client.act({ revision: view.revision, action: 'add', value: 'Typed task', _meta: meta() })).view.state;
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args, _meta: meta() });
    return result.isError ? result.content[0].text : JSON.parse(result.content[0].text);
  };
  let task = await tool('get_current');
  const update = async (args: Record<string, unknown>) => {
    const result = await tool('update_current', { expected_updated_at: task.updated_at, ...args });
    if (typeof result !== 'string') task = result;
    return typeof result === 'string' ? result : result.agent_notes;
  };
  // Text: only set, and only a string.
  assert.deepEqual(await update({ set: { Notes: 'first\nsecond' } }), { Notes: 'first\nsecond' });
  assert.match(await update({ append: { Notes: 'third' } }), /Field "Notes" is text: use set or remove, not append\./);
  assert.match(await update({ remove_items: { Notes: 'first' } }), /is text: use set or remove, not remove_items\./);
  assert.match(await update({ set: { Notes: ['a'] } }), /set takes a string, not a list/);
  // A list keeps duplicates; a unique list drops them, whether given as lines or an array.
  assert.deepEqual((await update({ set: { Links: 'a\n\n a \nb' }, append: { PRs: ['one', 'one', 'two'] } })),
    { Notes: 'first\nsecond', Links: ['a', 'a', 'b'], PRs: ['one', 'two'] });
  assert.deepEqual((await update({ append: { Links: ['b'], PRs: 'two\nthree' } })),
    { Notes: 'first\nsecond', Links: ['a', 'a', 'b', 'b'], PRs: ['one', 'two', 'three'] });
  assert.deepEqual((await update({ remove_items: { Links: 'a', PRs: ['two', 'absent'] } })).PRs, ['one', 'three']);
  assert.deepEqual(task.agent_notes.Links, ['b', 'b']);
  assert.deepEqual((await update({ set: { PRs: ['x', 'x', 'y'] } })).PRs, ['x', 'y']);
  // An emptied list removes the field; one operation per field still holds.
  assert.deepEqual(await update({ remove_items: { Links: ['b'] }, set: { PRs: [] } }), { Notes: 'first\nsecond' });
  assert.match(await update({ append: { PRs: 'a' }, remove_items: { ' PRs ': 'a' } }), /multiple operations/);
  // A field without a definition keeps a text value that append extends by unique lines.
  assert.deepEqual(await update({ append: { Other: 'a\na\nb' } }), { Notes: 'first\nsecond', Other: 'a\nb' });
  assert.match(await update({ remove_items: { Other: 'a' } }), /is text \(it has no definition\): use set, append or remove, not remove_items\./);
  // Text saved before the field was a list becomes an array on the next write.
  await writeFile(join(dir, 'pi-note.json'), JSON.stringify({ footer: { fields: [{ name: 'Other', type: 'unique-list' }] } }));
  assert.deepEqual((await update({ append: { Other: 'c' } })).Other, ['a', 'b', 'c']);
  const definitions = await tool('fields');
  assert.deepEqual(definitions.fields.map((field: { name: string; type: string }) => [field.name, field.type]), [['Other', 'unique-list'], ['Worktrees', 'unique-list'], ['PRs', 'unique-list']]);
  assert.match(await client.readContext(meta()), /"agent_notes":\{"Notes":"first\\nsecond","Other":\["a","b","c"\]\}[^]*"name":"Other","label":"Other","link":true,"format":"<value>","type":"unique-list"/);
});

test('field updates need a note CLI that keeps lists', async (t) => {
  const dir = await profile(t), command = join(dir, 'note');
  await writeFile(command, `#!${process.execPath}
const args = process.argv.slice(2);
console.log(args[0] === '--version' ? 'pinote 0.30.0' : JSON.stringify({ id: 1, text: 'Task', state: 'in_progress', tag: null, updated_at: 'r', agent_notes: {}, 'pi-sessions': [] }));
`, { mode: 0o700 });
  process.env.PINOTE_NOTE_COMMAND = command;
  const client = connectEngine();
  t.after(() => client.close());
  const result = await client.callTool({ name: 'update_current', arguments: { expected_updated_at: 'r', set: { Notes: 'text only' } },
    _meta: { 'native-ui/context': { conversationId: 'conversation', piSessionId: '12345678-1234-4234-8234-123456789012', state: { selectedId: 1 } } } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Updating fields requires note 0\.31\.0\+/);
});
