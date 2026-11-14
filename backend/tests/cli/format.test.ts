import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as markdown from '../../src/markdown.ts';
import { render } from '../../src/notify.ts';
test('Markdown roundtrip preserves literal multiline and Unicode separators', () => {
  const text = 'first\n\n# heading\n- literal\n    indented\nlast\u2028line\u2029end';
  assert.deepEqual(markdown.parse(markdown.export([{text, state:'active'}])), [[text,'active',null]]);
  const separators = 'first\u2028second\u2029third';
  assert.deepEqual(markdown.parse(markdown.export([{text:separators,state:'active'}])), [[separators,'active',null]]);
  assert.equal(markdown.export([{text:'gone',state:'removed'},{text:'later',state:'scheduled'}]), '# Reminders\n\n');
});
test('tag parents, one child level, tabs, checkbox continuations', () => {
  assert.deepEqual(markdown.parse('  - orphan\n- loose\n- Work\n\t- first\n\t  - ignored\n\t- [~] next\n        detail\n- [x] end'), [
    ['loose','active',null],['first','active','Work'],['next\ndetail','in_progress','Work'],['end','done',null],
  ]);
});
test('notification code-point limits, Python whitespace, markup escaping', () => {
  const notes = Array.from({length:12}, (_,i)=>({id:BigInt(i+1),text:'🐦'.repeat(200),state:'active' as const}));
  const body = render(notes);
  assert.ok(body.includes('🐦'.repeat(179)+'…'));
  assert.ok(!body.includes('11.'));
  assert.ok(body.includes('2 more'));
  assert.ok(render([{id:9223372036854775807n,text:"<b>O'Brien & friends</b>\u0085next\ufeff",state:'in_progress'}]).includes("9223372036854775807. [in progress] &lt;b&gt;O'Brien &amp; friends&lt;/b&gt; next\ufeff"));
  assert.ok(render([]).includes('No active reminders.'));
});
