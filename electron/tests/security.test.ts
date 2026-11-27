import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultTaskActions, initialState, normalizeTaskActions, TASK_ACTION_IDS, TASK_ACTION_STATES, taskActionIds } from '../src/protocol.ts';
import type { LegacyPerStateTaskActionSettings, LegacyTaskActionSettings } from '../src/protocol.ts';
import { MAX_STATE_FILE_BYTES, MAX_STATE_PAYLOAD_BYTES, mutating, safeLink, validEnvelope, validMenuRequest, validParams, validPreviewData, validPreviewRequest, validState, validWindowStartup } from '../src/security.ts';

test('privileged boundary rejects malformed commands, unsafe links and corrupt draft state', () => {
  assert.ok(validParams('edit', { id: 1, revision: 'rev', text: 'literal <script>☘</script>' }));
  assert.ok(!validParams('__proto__', {}));
  assert.ok(!validParams('edit', { id: 1, revision: 'rev', text: 'x', executable: '/bin/sh' }));
  assert.ok(!validParams('edit', { id: true, revision: 'rev', text: 'x' }));
  assert.ok(validParams('agent', { id: 1, revision: 'rev', fields: { PRs: 'https://example.test/1', Worktree: null } }));
  assert.ok(validParams('agent', { id: 1, revision: 'rev', fields: { PRs: ['https://example.test/1', 'https://example.test/2'] } }));
  for (const fields of [undefined, null, [], { PRs: 1 }, { PRs: [1] }, { PRs: [null] }, { PRs: Array(257).fill('x') }, { PRs: Array(256).fill('x'.repeat(1024)) }, { ['x'.repeat(257)]: 'v' }]) assert.ok(!validParams('agent', { id: 1, revision: 'rev', fields }));
  assert.ok(!validParams('transition', { id: 1, revision: 'rev', state: 'active', action: 'erase' }));
  assert.ok(validMenuRequest({ kind: 'app', x: 0, y: 100 }));
  for (const startup of [{}, { position: { x: -2560, y: 1030 } }, { size: { width: 280, height: 120 } }, { position: { x: 30, y: 1030 }, size: { width: 650, height: 400 } }]) assert.ok(validWindowStartup(startup));
  for (const startup of [null, [], { position: { x: 1 } }, { position: { x: 0.5, y: 0 } }, { size: { width: 279, height: 400 } }, { size: { width: 650, height: 400, depth: 1 } }, { position: { x: 0, y: 100001 } }, { anchor: 'top' }]) assert.ok(!validWindowStartup(startup));
  for (const inProgress of [false, true]) for (const readOnly of [false, true]) {
    assert.ok(!validMenuRequest({ kind: 'task', x: 10, y: 20, inProgress, readOnly }));
  }
  for (const request of [null, {}, { kind: 'app', x: NaN, y: 0 }, { kind: 'app', x: -1, y: 0 }, { kind: 'app', x: 0.5, y: 0 }, { kind: 'app', x: 0, y: Infinity }, { kind: 'task', x: 0, y: 0 }, { kind: 'app', x: 0, y: 0, items: ['execute'] }, { kind: 'app', x: 0, y: 0, inProgress: false, readOnly: false }, { kind: 'task', x: 0, y: 0, inProgress: 'yes', readOnly: false }]) assert.ok(!validMenuRequest(request));
  const task = { id: 1, text: 'Preview', tag: null, state: 'active', created_at: 'now', updated_at: 'rev', remind_at: null, reminder_due_at: null, archived_at: null, agent_notes: {}, agent_event_id: 0, pi_sessions: [] };
  const data = { task, markdown: true, unread: false };
  const request = { token: 1, data, point: { x: 0, y: 100 } };
  assert.ok(validPreviewData(data));
  // A list field arrives as an array, with the definitions that format its entries.
  assert.ok(validPreviewData({ ...data, task: { ...task, agent_notes: { PRs: ['https://example.test/1'], Notes: 'text' } }, fields: [{ name: 'PRs', type: 'unique-list', link: true, format: '#<number>' }] }));
  for (const fields of [null, {}, [{ name: 'PRs' }], [{ name: 'PRs', link: true, format: '' }], [{ name: 'PRs', type: 'set', link: true, format: '' }], [{ name: 'PRs', type: 'list', link: 'yes', format: '' }], [{ name: 'PRs', type: 'list', link: true, format: '', extra: 1 }]]) assert.ok(!validPreviewData({ ...data, fields }));
  assert.ok(!validPreviewData({ ...data, task: { ...task, agent_notes: { PRs: [1] } } }));
  assert.ok(validPreviewRequest(request));
  const snapshot = (pi_sessions: unknown) => ({ protocol: 1, ok: true, result: {
    notes: [{ ...task, pi_sessions }], tags: [],
    config: { maxVisibleNotes: 10, markdownPreview: true },
  } });
  for (const pi_sessions of [[], ['abc-123', 'a.b_c'], ['a'.repeat(256)]]) {
    assert.ok(validPreviewData({ ...data, task: { ...task, pi_sessions } }));
    assert.ok(validEnvelope('snapshot', snapshot(pi_sessions)));
  }
  for (const pi_sessions of [undefined, null, {}, 'session', [1], [null], [''], ['a'.repeat(257)],
    ['<script>'], ['**bold**'], ['space id'], ['a\n'], ['-id'], ['id.'], Array(1)]) {
    assert.ok(!validPreviewData({ ...data, task: { ...task, pi_sessions } }));
    assert.ok(!validEnvelope('snapshot', snapshot(pi_sessions)));
  }
  for (const value of [null, {}, { ...data, markdown: 'yes' }, { ...data, unread: 1 },
    { ...data, task: { ...task, id: true } }, { ...data, task: { ...task, agent_event_id: -1 } },
    { ...data, executable: '/bin/sh' }, { ...data, task: { ...task, text: 'x'.repeat(MAX_STATE_PAYLOAD_BYTES + 1) } },
  ]) assert.ok(!validPreviewData(value));
  for (const value of [null, {}, { ...request, token: 0 }, { ...request, token: 1.5 },
    { ...request, token: Number.MAX_SAFE_INTEGER + 1 }, { ...request, data: null },
    { ...request, point: null }, { ...request, point: { x: -1, y: 0 } },
    { ...request, point: { x: NaN, y: 0 } }, { ...request, point: { x: 0, y: Infinity } },
    { ...request, point: { x: 0.5, y: 0 } }, { ...request, point: { x: 100001, y: 0 } },
    { ...request, point: { x: 0, y: 0, command: 'edit' } }, { ...request, command: 'edit' },
  ]) assert.ok(!validPreviewRequest(value));
  assert.ok(validState(initialState())); // Legacy state without working-state fields remains readable.
  assert.ok(validState({ ...initialState(), creationTag: 'Work', collapsed: true, scroll: { ordinary: 42, pinned: 0 } }));
  assert.ok(validState({ ...initialState(), creationTag: null, collapsed: false }));
  for (const composerStartAsMarkdown of [false, true]) assert.ok(validState({ ...initialState(), composerStartAsMarkdown }));
  assert.ok(validState({ ...initialState(), kittyTabTitle: '{tag}{title}' }));
  for (const kittyStartPrompt of ['', 'Check scope\n\tthen wait 🌱', '🌱'.repeat(4000)]) assert.ok(validState({ ...initialState(), kittyStartPrompt }));
  assert.ok(validState({ ...initialState(), tagBaseFolder: '/home/me/projects' }));
  assert.ok(validState({ ...initialState(), settingsTab: 'window' }));
  for (const settingsTab of ['Window', 'manage-tags', 1, null]) assert.ok(!validState({ ...initialState(), settingsTab }));
  for (const extra of [
    ...[null, 'true', 1, {}].map(composerStartAsMarkdown => ({ composerStartAsMarkdown })),
    ...[1, '', ' ', 'a\tb', '\ud800', 'x'.repeat(257)].map(kittyTabTitle => ({ kittyTabTitle })), ...[1, '', 'relative', '/a\nb', '/' + 'x'.repeat(4096)].map(tagBaseFolder => ({ tagBaseFolder })),
    ...[1, null, '\x1b[31m', '\u202e', '\u200f', '\ud800', '🌱'.repeat(4001)].map(kittyStartPrompt => ({ kittyStartPrompt })), { creationTag: '' }, { creationTag: 1 }, { creationTag: 'x'.repeat(257) }, { collapsed: 'yes' },
    { scroll: null }, { scroll: { ordinary: 0 } }, { scroll: { ordinary: -1, pinned: 0 } },
    { scroll: { ordinary: Infinity, pinned: 0 } }, { scroll: { ordinary: 0, pinned: 0, extra: 1 } },
  ]) assert.ok(!validState({ ...initialState(), ...extra }));
  assert.ok(!validState({ ...initialState(), edits: { '__proto__': { text:'x', revision:'rev' } } }));
  assert.ok(!validState({ ...initialState(), edits: { '1': { text:'x' } } }));
  assert.ok(validState({ ...initialState(), edits: { '1': { text:'x', revision:'rev', fields: { PRs: '', Worktree: '/tmp/work' } } } }));
  assert.ok(validState({ ...initialState(), edits: { '1': { text:'x', revision:'rev', fields: { PRs: [], Worktrees: ['/tmp/work'] } } } }));
  for (const fields of [null, [], { PRs: null }, { PRs: 1 }, { PRs: [1] }]) assert.ok(!validState({ ...initialState(), edits: { '1': { text:'x', revision:'rev', fields } } }));
  for (const pendingTag of [null, 'Work']) assert.ok(validState({ ...initialState(), edits: { '1': { text:'x', revision:'rev', pendingTag } } }));
  for (const pendingTag of [undefined, true, 1, {}, 'x'.repeat(257)]) assert.ok(!validState({ ...initialState(), edits: { '1': { text:'x', revision:'rev', pendingTag } } }));
  for (const pendingTagFolder of [null, '/tmp']) assert.ok(validState({ ...initialState(), edits: { '1': { text:'x', revision:'rev', pendingTag:'Work', pendingTagFolder } } }));
  assert.ok(validState({ ...initialState(), edits: { '1': { text:'x', revision:'rev', pendingTag:'Work', pendingTagFolder:null, pendingTagFolderIfNew:'/tmp/Work' } } }));
  for (const extra of [{pendingTagFolder:'/tmp'}, {pendingTag:null,pendingTagFolder:null}, {pendingTag:'Work',pendingTagFolder:1}, {pendingTagFolderIfNew:'/tmp'}, {pendingTag:'Work',pendingTagFolderIfNew:null}]) assert.ok(!validState({ ...initialState(), edits: { '1': { text:'x', revision:'rev', ...extra } } }));
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'https://a\n.b']) assert.ok(!safeLink(url));
  for (const url of ['https://example.org/path', 'http://example.org', 'mailto:user@example.org']) assert.ok(safeLink(url));
  assert.ok(!validEnvelope('add', { protocol:1, ok:false, error: { code:'unknown', message: 1 } }));
  for (const result of [null, {}, {changed:true}, {changed:false,id:1}]) assert.ok(!validEnvelope('add', {protocol:1,ok:true,result}));
  assert.ok(validEnvelope('add', {protocol:1,ok:true,result:{changed:true,id:1}}));
  assert.ok(!validEnvelope('snapshot', {protocol:1,ok:true,result:{notes:[],tags:[]}}));
  assert.ok(validEnvelope('agent', {protocol:1,ok:true,result:{changed:true,id:1,revision:'rev',agentEvent:3}}));
  for (const result of [{changed:true,id:1,revision:'rev'}, {changed:true,id:1,agentEvent:3}, {changed:true,id:1,revision:'rev',agentEvent:-1}]) assert.ok(!validEnvelope('agent', {protocol:1,ok:true,result}));
});

test('mutation acknowledgements accept optional bounded printable revisions', () => {
  for (const operation of ['edit', 'tag', 'create_tag', 'transition'] as const) {
    const result = { changed: true, id: 1, tag: 'Work' };
    const accepts = (value: unknown) => validEnvelope(operation, { protocol: 1, ok: true, result: value });
    assert.ok(accepts(result)); // Older backends and unrelated operations remain compatible.
    for (const revision of ['rev', 'x'.repeat(128), 'printable space', 'é']) {
      assert.ok(accepts({ ...result, revision }));
      assert.ok(accepts({ ...result, changed: false, revision }));
    }
    for (const revision of [undefined, null, 1, true, '', 'x'.repeat(129), 'a\n', '\x00', '\x7f', '\u0085', '\u00a0', '\u200b', '\ud800']) {
      assert.ok(!accepts({ ...result, revision }));
    }
  }
});

const legacyIds = TASK_ACTION_IDS.filter(id => id !== 'preview');
const legacyShared = (): LegacyTaskActionSettings => ({ order: [...legacyIds].reverse(), hidden: ['kitty', 'done'], primary: 'start' });
const legacyStates = (): LegacyPerStateTaskActionSettings => ({
  active: legacyShared(),
  in_progress: { order: [...legacyIds], hidden: ['start'], primary: 'edit' },
  marked: { order: [...legacyIds, 'unmark'], hidden: ['unmark'], primary: 'copy' },
});

test('task action preferences accept exact old and new formats and reject malformed values', () => {
  const state = initialState();
  assert.ok(!Object.hasOwn(state, 'taskActions'));
  assert.ok(validState(state));
  const defaults = defaultTaskActions();
  const old = legacyStates();
  const legacy = legacyShared();
  const accepts = (taskActions: unknown) => validState({ ...state, taskActions });
  for (const value of [defaults, old, legacy]) assert.ok(accepts(value));
  for (const value of [null, undefined, [], 'start', {},
    { ...defaults, extra: true }, { active: defaults.active, marked: defaults.marked },
    { ...defaults, ...legacy }, { ...defaults, in_progress: undefined },
    { ...defaults, marked: old.marked }, { ...old, active: defaults.active },
  ]) assert.ok(!accepts(value), JSON.stringify(value));
  for (const settings of [defaults, old]) for (const key of TASK_ACTION_STATES) {
    const preferences = settings[key];
    const check = (value: unknown) => accepts({ ...settings, [key]: value });
    assert.ok(check({ ...preferences, order: [...preferences.order].reverse(), hidden: [...preferences.order] }));
    for (const value of [
      null, undefined, [], {},
      { order: preferences.order, hidden: [] },
      { ...preferences, extra: true },
      { ...preferences, order: preferences.order.slice(1) },
      { ...preferences, order: [...preferences.order, 'kitty'] },
      { ...preferences, order: preferences.order.map(() => 'kitty') },
      { ...preferences, order: [...preferences.order.slice(1), 'unknown'] },
      { ...preferences, order: Array(preferences.order.length) },
      { ...preferences, hidden: ['copy', 'copy'] },
      { ...preferences, hidden: ['unknown'] },
      { ...preferences, hidden: ['actions'] },
      { ...preferences, hidden: Array(1) },
      { ...preferences, hidden: null },
      { ...preferences, hidden: 'copy' },
      ...('primary' in preferences ? [
        { ...preferences, primary: 'unknown' }, { ...preferences, primary: null },
        { ...preferences, primary: 'preview' }, { ...preferences, row: ['task-tag', 'task-text'] },
        { ...preferences, order: [...preferences.order, 'preview'] }, { ...preferences, hidden: ['preview'] },
      ] : [{ ...preferences, primary: 'start' }]),
    ]) assert.ok(!check(value), `${key}: ${JSON.stringify(value)}`);
    if (key !== 'marked') {
      assert.ok(!check({ ...preferences, order: [...preferences.order.slice(1), 'unmark'] }));
      assert.ok(!check({ ...preferences, hidden: ['unmark'] }));
      assert.ok(!check({ ...preferences, ...('primary' in preferences ? { primary: 'unmark' } : { row: ['unmark', 'task-tag', 'task-text'] }) }));
    } else {
      assert.ok(check({ ...preferences, hidden: ['unmark'] }));
      assert.ok(!check({ ...preferences, order: preferences.order.filter(id => id !== 'unmark') }));
    }
  }
  for (const value of [
    { ...legacy, row: ['task-tag', 'task-text'] }, { ...legacy, primary: 'unmark' },
    { ...legacy, order: [...legacy.order, 'preview'] }, { ...legacy, hidden: ['preview'] },
    { ...legacy, extra: true }, { ...legacy, order: Array(legacy.order.length) },
    { ...legacy, hidden: ['copy', 'copy'] }, { ...legacy, primary: 'actions' },
  ]) assert.ok(!accepts(value));
});

test('task row validation requires unique tag and text and allows optional reordered actions', () => {
  for (const key of TASK_ACTION_STATES) {
    const defaults = defaultTaskActions();
    const accepts = (row: unknown) => validState({ ...initialState(), taskActions: { ...defaults, [key]: { ...defaults[key], row } } });
    for (const row of [['task-text', 'task-tag'], ['actions', 'preview', 'task-text', 'copy', 'task-tag'], [...taskActionIds(key), 'actions', 'task-tag', 'task-text']]) assert.ok(accepts(row));
    for (const row of [null, undefined, 'task-tag', [], ['task-tag'], ['task-text'],
      ['task-tag', 'task-text', 'task-tag'], ['task-tag', 'task-text', 'task-text'],
      ['task-tag', 'task-text', 'preview', 'preview'], ['task-tag', 'task-text', 'actions', 'actions'],
      ['task-tag', 'task-text', 'unknown'], ['task-tag', 'task-text', ...Array(1)],
      Object.assign(Array(3), { 0: 'task-tag', 2: 'task-text' }),
    ]) assert.ok(!accepts(row), JSON.stringify(row));
  }
});

test('task action defaults and normalization migrate both legacy formats without mutation or shared arrays', () => {
  assert.deepEqual(TASK_ACTION_IDS, ['kitty','copy','start','done','archive','edit','schedule','tag','preview']);
  assert.deepEqual(TASK_ACTION_STATES, ['active','in_progress','marked']);
  const defaults = defaultTaskActions();
  for (const state of TASK_ACTION_STATES) {
    const ids = [...legacyIds, ...(state === 'marked' ? ['unmark'] : []), 'preview'];
    assert.deepEqual(taskActionIds(state), ids);
    assert.notStrictEqual(taskActionIds(state), taskActionIds(state));
    assert.deepEqual(defaults[state], { order: ids, hidden: [], row: [state === 'active' ? 'start' : state === 'in_progress' ? 'done' : 'unmark', 'task-tag', 'task-text', 'preview', 'actions'] });
  }
  assert.deepEqual(normalizeTaskActions(), defaults);
  for (const primary of legacyIds) {
    const legacy: LegacyTaskActionSettings = { ...legacyShared(), primary };
    const migrated = normalizeTaskActions(legacy);
    for (const state of TASK_ACTION_STATES) {
      assert.deepEqual(migrated[state].order, [...legacy.order, ...(state === 'marked' ? ['unmark'] : []), 'preview']);
      assert.deepEqual(migrated[state].hidden, legacy.hidden);
      assert.deepEqual(migrated[state].row, [state === 'marked' ? 'unmark' : state === 'in_progress' && primary === 'start' ? 'done' : primary, 'task-tag', 'task-text', 'preview', 'actions']);
    }
    assert.ok(validState({ ...initialState(), taskActions: migrated }));
  }
  const old = legacyStates();
  const migrated = normalizeTaskActions(old);
  for (const state of TASK_ACTION_STATES) {
    assert.deepEqual(migrated[state], { order: [...old[state].order, 'preview'], hidden: old[state].hidden, row: [old[state].primary, 'task-tag', 'task-text', 'preview', 'actions'] });
  }
  assert.ok(validState({ ...initialState(), taskActions: migrated }));
  old.in_progress.primary = 'start';
  old.marked.primary = 'unmark';
  assert.equal(normalizeTaskActions(old).in_progress.row[0], 'start');
  assert.equal(normalizeTaskActions(old).marked.row[0], 'unmark');
  defaults.active.order.reverse();
  defaults.in_progress.hidden.push('copy');
  defaults.marked.row = ['task-text', 'edit', 'task-tag'];
  assert.deepEqual(normalizeTaskActions(defaults), defaults);
  for (const input of [undefined, legacyShared(), old, defaults]) {
    const serialized = JSON.stringify(input);
    const result = normalizeTaskActions(input);
    for (const state of TASK_ACTION_STATES) {
      for (const field of ['order', 'hidden', 'row'] as const) {
        for (const other of TASK_ACTION_STATES.filter(other => other !== state)) assert.notStrictEqual(result[state][field], result[other][field]);
        if (input) {
          const source = 'order' in input ? input : input[state];
          if (field in source) assert.notStrictEqual(result[state][field], source[field as keyof typeof source]);
        }
      }
      result[state].order.reverse();
      result[state].hidden.push('tag');
      result[state].row.reverse();
    }
    assert.equal(JSON.stringify(input), serialized);
  }
  const first = defaultTaskActions();
  const second = defaultTaskActions();
  first.active.order.reverse();
  first.active.hidden.push('tag');
  first.active.row.reverse();
  assert.deepEqual(second, normalizeTaskActions());
});

test('a full draft payload reserves space for the largest escaped recovery warning', () => {
  const state = initialState();
  for (let id=1; id<=16; id++) state.edits[String(id)] = { text:'x'.repeat(65536), revision:'rev' };
  const excess = Buffer.byteLength(JSON.stringify(state)) - MAX_STATE_PAYLOAD_BYTES;
  state.edits['16'].text = state.edits['16'].text.slice(0,65536-excess);
  state.warning = '\u0000'.repeat(4096);
  assert.ok(validState(state));
  assert.equal(Buffer.byteLength(JSON.stringify(state)), MAX_STATE_FILE_BYTES);
  state.edits['16'].text += 'x';
  assert.ok(!validState(state));
});
test('image operations accept only bounded base64 and SHA-256 hashes', () => {
  const hash = 'a'.repeat(64);
  assert.ok(validParams('image_add', { data: 'UklGRg==' }));
  for (const data of ['', 'UklGRg=', 'not base64!', 'A'.repeat(Math.ceil(4 * 1024 * 1024 / 3) * 4 + 4)]) assert.ok(!validParams('image_add', { data }));
  assert.ok(validParams('image', { hash }) && !validParams('image', { hash: hash.toUpperCase() }) && !validParams('image', { hash: '../index.html' }));
  assert.ok(validParams('image_prune', { keep: [hash] }) && !validParams('image_prune', { keep: ['x'] }));
  assert.ok(validEnvelope('image', { protocol: 1, ok: true, result: { found: true, mime: 'image/webp', data: 'UklGRg==' } }));
  assert.ok(validEnvelope('image', { protocol: 1, ok: true, result: { found: false } }));
  assert.ok(!validEnvelope('image', { protocol: 1, ok: true, result: { found: true, mime: 'image/svg+xml', data: 'UklGRg==' } }));
  assert.ok(validEnvelope('image_add', { protocol: 1, ok: true, result: { changed: true, hash, mime: 'image/png', width: 2, height: 2 } }));
  assert.ok(!validEnvelope('image_add', { protocol: 1, ok: true, result: { changed: true, hash: 'x', mime: 'image/png', width: 2, height: 2 } }));
  assert.ok(validEnvelope('image_prune', { protocol: 1, ok: true, result: { changed: true, removed: [hash] } }));
  assert.ok(!validEnvelope('image_prune', { protocol: 1, ok: true, result: { changed: true, removed: ['../x'] } }));
});
test('stats is a read-only operation with a validated result', () => {
  const result = { database: { path: '/home/u/.local/share/pinote/notes.db', bytes: 4096, modified: '2026-11-27T22:40:00.000Z' }, log: { path: '/home/u/.local/state/pinote/app.log', bytes: null },
    tasks: { active: 3, in_progress: 1, scheduled: 0, done: 2, removed: 0 }, images: { count: 1, bytes: 120 }, events: 9 };
  assert.ok(validParams('stats', {}) && !validParams('stats', { path: '/etc/passwd' }) && !mutating('stats'));
  assert.ok(validEnvelope('stats', { protocol: 1, ok: true, result }));
  for (const bad of [{ ...result, database: { ...result.database, path: 'notes.db' } }, { ...result, database: { ...result.database, modified: 'yesterday' } }, { ...result, log: { ...result.log, bytes: -1 } },
    { ...result, tasks: { ...result.tasks, done: 1.5 } }, { ...result, images: { count: 1 } }, { ...result, events: undefined }, { ...result, extra: 1 }])
    assert.ok(!validEnvelope('stats', { protocol: 1, ok: true, result: bad }));
});
