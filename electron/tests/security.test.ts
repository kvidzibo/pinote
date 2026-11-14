import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultTaskActions, initialState, TASK_ACTION_IDS } from '../src/protocol.ts';
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

test('task action preferences are bounded, optional and independently defaulted', () => {
  const legacy = initialState();
  const serialized = JSON.stringify(legacy);
  assert.ok(!Object.hasOwn(legacy, 'taskActions'));
  assert.ok(validState(legacy));
  assert.equal(JSON.stringify(legacy), serialized);
  const defaults = defaultTaskActions();
  assert.deepEqual(defaults, { order: [...TASK_ACTION_IDS], hidden: [], primary: 'start' });
  assert.ok(validState({ ...legacy, taskActions: defaults }));
  assert.ok(validState({ ...legacy, taskActions: { order: [...TASK_ACTION_IDS].reverse(), hidden: ['kitty', 'done'], primary: 'done' } }));
  assert.ok(validState({ ...legacy, taskActions: { ...defaults, hidden: [...TASK_ACTION_IDS] } }));
  for (const taskActions of [
    null, undefined, [], 'start', {},
    { order: defaults.order, hidden: [] },
    { order: defaults.order, primary: 'start' },
    { hidden: [], primary: 'start' },
    { ...defaults, extra: true },
    { ...defaults, order: defaults.order.slice(1) },
    { ...defaults, order: [...defaults.order, 'kitty'] },
    { ...defaults, order: defaults.order.map(() => 'kitty') },
    { ...defaults, order: [...defaults.order.slice(1), 'unknown'] },
    { ...defaults, order: Array(8) },
    { ...defaults, hidden: ['copy', 'copy'] },
    { ...defaults, hidden: ['unknown'] },
    { ...defaults, hidden: Array(1) },
    { ...defaults, hidden: null },
    { ...defaults, hidden: 'copy' },
    { ...defaults, primary: 'unknown' },
    { ...defaults, primary: null },
  ]) assert.ok(!validState({ ...legacy, taskActions }), JSON.stringify(taskActions));
  const other = defaultTaskActions();
  defaults.order.reverse();
  defaults.hidden.push('start');
  defaults.primary = 'done';
  assert.deepEqual(other, { order: [...TASK_ACTION_IDS], hidden: [], primary: 'start' });
  assert.deepEqual(defaultTaskActions(), other);
  assert.deepEqual(initialState(), legacy);
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
