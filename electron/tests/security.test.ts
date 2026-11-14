import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultTaskActions, initialState, normalizeTaskActions, TASK_ACTION_IDS, TASK_ACTION_STATES, taskActionIds } from '../src/protocol.ts';
import type { LegacyTaskActionSettings } from '../src/protocol.ts';
import { MAX_STATE_FILE_BYTES, MAX_STATE_PAYLOAD_BYTES, safeLink, validEnvelope, validMenuRequest, validParams, validState } from '../src/security.ts';

test('privileged boundary rejects malformed commands, unsafe links and corrupt draft state', () => {
  assert.ok(validParams('edit', { id: 1, revision: 'rev', text: 'literal <script>☘</script>' }));
  assert.ok(!validParams('__proto__', {}));
  assert.ok(!validParams('edit', { id: 1, revision: 'rev', text: 'x', executable: '/bin/sh' }));
  assert.ok(!validParams('edit', { id: true, revision: 'rev', text: 'x' }));
  assert.ok(!validParams('transition', { id: 1, revision: 'rev', state: 'active', action: 'erase' }));
  assert.ok(validMenuRequest({ kind: 'app', x: 0, y: 100 }));
  for (const inProgress of [false, true]) for (const readOnly of [false, true]) {
    assert.ok(!validMenuRequest({ kind: 'task', x: 10, y: 20, inProgress, readOnly }));
  }
  for (const request of [null, {}, { kind: 'app', x: NaN, y: 0 }, { kind: 'app', x: -1, y: 0 }, { kind: 'app', x: 0.5, y: 0 }, { kind: 'app', x: 0, y: Infinity }, { kind: 'task', x: 0, y: 0 }, { kind: 'app', x: 0, y: 0, items: ['execute'] }, { kind: 'app', x: 0, y: 0, inProgress: false, readOnly: false }, { kind: 'task', x: 0, y: 0, inProgress: 'yes', readOnly: false }]) assert.ok(!validMenuRequest(request));
  assert.ok(validState(initialState()));
  assert.ok(!validState({ ...initialState(), edits: { '__proto__': { text:'x', revision:'rev' } } }));
  assert.ok(!validState({ ...initialState(), edits: { '1': { text:'x' } } }));
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'https://a\n.b']) assert.ok(!safeLink(url));
  for (const url of ['https://example.org/path', 'http://example.org', 'mailto:user@example.org']) assert.ok(safeLink(url));
  assert.ok(!validEnvelope('add', { protocol:1, ok:false, error: { code:'unknown', message: 1 } }));
  for (const result of [null, {}, {changed:true}, {changed:false,id:1}]) assert.ok(!validEnvelope('add', {protocol:1,ok:true,result}));
  assert.ok(validEnvelope('add', {protocol:1,ok:true,result:{changed:true,id:1}}));
  assert.ok(!validEnvelope('snapshot', {protocol:1,ok:true,result:{notes:[],tags:[]}}));
});

test('task action preferences accept exact state maps and legacy settings and reject malformed values', () => {
  const state = initialState();
  assert.ok(!Object.hasOwn(state, 'taskActions'));
  assert.ok(validState(state));
  const defaults = defaultTaskActions();
  assert.ok(validState({ ...state, taskActions: defaults }));
  const legacy: LegacyTaskActionSettings = { order: [...TASK_ACTION_IDS].reverse(), hidden: ['kitty', 'done'], primary: 'done' };
  assert.ok(validState({ ...state, taskActions: legacy }));
  for (const taskActions of [null, undefined, [], 'start', {},
    { ...defaults, extra: true }, { active: defaults.active, marked: defaults.marked },
    { ...defaults, ...legacy }, { ...defaults, in_progress: undefined },
  ]) assert.ok(!validState({ ...state, taskActions }), JSON.stringify(taskActions));
  for (const key of ['legacy', ...TASK_ACTION_STATES] as const) {
    const preferences = key === 'legacy' ? legacy : defaults[key];
    const accepts = (value: unknown) => validState({ ...state, taskActions: key === 'legacy' ? value : { ...defaults, [key]: value } });
    assert.ok(accepts({ ...preferences, order: [...preferences.order].reverse(), hidden: [...preferences.order] }));
    for (const value of [
      null, undefined, [], {},
      { order: preferences.order, hidden: [] },
      { order: preferences.order, primary: preferences.primary },
      { hidden: [], primary: preferences.primary },
      { ...preferences, extra: true },
      { ...preferences, order: preferences.order.slice(1) },
      { ...preferences, order: [...preferences.order, 'kitty'] },
      { ...preferences, order: preferences.order.map(() => 'kitty') },
      { ...preferences, order: [...preferences.order.slice(1), 'unknown'] },
      { ...preferences, order: Array(preferences.order.length) },
      { ...preferences, hidden: ['copy', 'copy'] },
      { ...preferences, hidden: ['unknown'] },
      { ...preferences, hidden: Array(1) },
      { ...preferences, hidden: null },
      { ...preferences, hidden: 'copy' },
      { ...preferences, primary: 'unknown' },
      { ...preferences, primary: null },
    ]) assert.ok(!accepts(value), `${key}: ${JSON.stringify(value)}`);
    if (key !== 'marked') {
      assert.ok(!accepts({ ...preferences, order: [...preferences.order.slice(1), 'unmark'] }));
      assert.ok(!accepts({ ...preferences, hidden: ['unmark'] }));
      assert.ok(!accepts({ ...preferences, primary: 'unmark' }));
    } else {
      assert.ok(accepts({ ...preferences, hidden: ['unmark'], primary: 'unmark' }));
      assert.ok(!accepts({ ...preferences, order: [...TASK_ACTION_IDS] }));
    }
  }
});

test('task action defaults and normalization provide independent per-state preferences and migrate legacy settings', () => {
  assert.deepEqual(TASK_ACTION_IDS, ['kitty','copy','start','done','archive','edit','schedule','tag']);
  assert.deepEqual(TASK_ACTION_STATES, ['active','in_progress','marked']);
  const defaults = defaultTaskActions();
  for (const state of TASK_ACTION_STATES) {
    const ids: string[] = [...TASK_ACTION_IDS, ...(state === 'marked' ? ['unmark'] : [])];
    assert.deepEqual(taskActionIds(state), ids);
    assert.notStrictEqual(taskActionIds(state), taskActionIds(state));
    assert.deepEqual(defaults[state], { order: ids, hidden: [], primary: state === 'active' ? 'start' : state === 'in_progress' ? 'done' : 'unmark' });
  }
  assert.deepEqual(normalizeTaskActions(), defaults);
  for (const primary of TASK_ACTION_IDS) {
    const legacy: LegacyTaskActionSettings = { order: [...TASK_ACTION_IDS].reverse(), hidden: ['start', 'kitty'], primary };
    const serialized = JSON.stringify(legacy);
    const migrated = normalizeTaskActions(legacy);
    assert.deepEqual(migrated.active, legacy);
    assert.deepEqual(migrated.in_progress, { ...legacy, primary: primary === 'start' ? 'done' : primary });
    assert.deepEqual(migrated.marked, { ...legacy, order: [...legacy.order, 'unmark'], primary: 'unmark' });
    assert.ok(validState({ ...initialState(), taskActions: migrated }));
    migrated.active.order.reverse();
    migrated.active.hidden.push('copy');
    assert.equal(JSON.stringify(legacy), serialized);
    assert.deepEqual(migrated.in_progress.order, legacy.order);
    assert.deepEqual(migrated.marked.hidden, legacy.hidden);
  }
  defaults.active.order.reverse();
  defaults.in_progress.hidden.push('copy');
  defaults.marked.primary = 'edit';
  const serialized = JSON.stringify(defaults);
  const normalized = normalizeTaskActions(defaults);
  assert.deepEqual(normalized, defaults);
  for (const result of [defaultTaskActions(), normalizeTaskActions(), normalized]) {
    for (const state of TASK_ACTION_STATES) {
      assert.notStrictEqual(result[state], defaults[state]);
      assert.notStrictEqual(result[state].order, defaults[state].order);
      assert.notStrictEqual(result[state].hidden, defaults[state].hidden);
      for (const other of TASK_ACTION_STATES.filter(other => other !== state)) {
        assert.notStrictEqual(result[state], result[other]);
        assert.notStrictEqual(result[state].order, result[other].order);
        assert.notStrictEqual(result[state].hidden, result[other].hidden);
      }
      result[state].order.reverse();
      result[state].hidden.push('tag');
    }
  }
  assert.equal(JSON.stringify(defaults), serialized);
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
