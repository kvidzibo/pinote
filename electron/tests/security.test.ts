import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../src/protocol.ts';
import { MAX_STATE_FILE_BYTES, MAX_STATE_PAYLOAD_BYTES, safeLink, validEnvelope, validMenuRequest, validParams, validState } from '../src/security.ts';

test('privileged boundary rejects malformed commands, unsafe links and corrupt draft state', () => {
  assert.ok(validParams('edit', { id: 1, revision: 'rev', text: 'literal <script>☘</script>' }));
  assert.ok(!validParams('__proto__', {}));
  assert.ok(!validParams('edit', { id: 1, revision: 'rev', text: 'x', executable: '/bin/sh' }));
  assert.ok(!validParams('edit', { id: true, revision: 'rev', text: 'x' }));
  assert.ok(!validParams('transition', { id: 1, revision: 'rev', state: 'active', action: 'erase' }));
  assert.ok(validMenuRequest({ kind: 'app', x: 0, y: 100 }));
  assert.ok(validMenuRequest({ kind: 'task', x: 10, y: 20, inProgress: false, readOnly: true }));
  for (const request of [null, {}, { kind: 'app', x: NaN, y: 0 }, { kind: 'app', x: -1, y: 0 }, { kind: 'app', x: 0.5, y: 0 }, { kind: 'app', x: 0, y: Infinity }, { kind: 'task', x: 0, y: 0 }, { kind: 'app', x: 0, y: 0, items: ['execute'] }, { kind: 'task', x: 0, y: 0, inProgress: 'yes', readOnly: false }]) assert.ok(!validMenuRequest(request));
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
