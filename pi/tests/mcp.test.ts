import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { visibleWidth } from '@earendil-works/pi-tui';

// Assert the wire limits independently of the service implementation.
const text = z.string().max(20_000);
const scalar = z.union([text, z.number(), z.boolean(), z.null()]);
const View = z.object({
  version: z.literal(1), title: text, revision: z.string().min(1).max(256), state: z.record(z.string(), z.unknown()), body: text.optional(), retainOnNew: z.boolean().optional(),
  controls: z.array(z.object({ id: z.string().min(1).max(256), label: text, revision: z.string().min(1).max(256).optional(), kind: z.enum(['action', 'text', 'number', 'toggle', 'select']), value: scalar.optional(), icon: z.string().max(8).optional(), description: text.optional(), multiline: z.boolean().optional(), confirm: text.optional(), options: z.array(z.object({ label: text, value: scalar })).max(256).optional() }).strict()).max(256),
  footer: z.array(z.object({ text, openApp: z.literal(true).optional(), url: z.string().max(2048).optional(), action: z.string().optional(), secondaryAction: z.string().optional(), doubleAction: z.string().optional(), style: z.object({ italic: z.boolean().optional(), color: z.enum(['accent', 'muted', 'text']).optional() }).strict().optional(), width: z.number().int().min(3).max(1000).optional() }).strict()).max(128).optional(),
}).strict();

// One end-to-end case exercises the UI contract against the real CLI and database.
test('native UI owns tasks/settings, rejects stale writes, and restores host selection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pinote-mcp-'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const config = join(dir, 'pi-note.json');
  await writeFile(config, JSON.stringify({ unrelated: true, agentGuidance: 'Custom guidance' }));
  const connect = async () => {
    const client = new Client({ name: 'native-ui-test', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'dist-mcp/mcp/server.js')],
      env: { PINOTE_NOTE_COMMAND: join(root, '../.venv/bin/note'), PI_CODING_AGENT_DIR: pathToFileURL(dir).href, XDG_DATA_HOME: dir, XDG_STATE_HOME: dir }, stderr: 'pipe' });
    transport.stderr?.on('data', () => {});
    await client.connect(transport);
    return client;
  };
  let client = await connect();
  let state: Record<string, unknown> = {};
  let scoped = false, secondary = false, styles = false, double = false, native = false;
  const meta = () => ({ 'native-ui/context': { conversationId: 'conversation-a', state }, ...((scoped || secondary || styles || double || native) ? { 'native-ui/features': { ...(scoped ? { actionRevisions: true } : {}), ...(secondary ? { footerSecondaryActions: true } : {}), ...(styles ? { footerStyles: true } : {}), ...(double ? { footerDoubleActions: true } : {}), ...(native ? { footerNativeActions: true } : {}) } } : {}) });
  const read = async () => {
    const result = await client.readResource({ uri: 'pinote://ui', _meta: meta() });
    assert.ok('text' in result.contents[0]);
    assert.ok(result.contents[0].text.length <= 256_000);
    return View.parse(JSON.parse(result.contents[0].text));
  };
  const act = async (view: any, action: string, value?: unknown) => {
    const result = await client.request({ method: 'native-ui/action', params: { uri: 'pinote://ui', revision: view.controls.find((control: any) => control.id === action)?.revision ?? view.revision, action, value, _meta: meta() } }, z.object({ view: View, draft: text.optional(), preview: text.optional() }));
    state = result.view.state;
    return result;
  };
  try {
    assert.equal((await client.listResources()).resources[0].mimeType, 'application/vnd.mcp-native-ui+json');
    let view = await read(); state = view.state;
    assert.equal(view.state.selectedId, null);
    const idleFooter = view.footer;
    native = true;
    assert.deepEqual((await read()).footer, [{ text: '▤ ', openApp: true, width: 3 }, { text: 'Pinote · No task', width: 60 }]);
    native = false;
    assert.deepEqual((await read()).footer, idleFooter, 'Regular host footer is unchanged');
    view = (await act(view, 'add', 'MCP task\n\nDetails')).view;
    const id = view.state.selectedId;
    assert.equal(typeof id, 'number');
    assert.match((await act(view, 'preview')).preview!, /Details/);
    const currentResult = await client.callTool({ name: 'get_current', arguments: {}, _meta: meta() });
    assert.equal(currentResult._meta?.['pinote/database'], join(dir, 'pinote/notes.db'));
    const task = JSON.parse((currentResult.content as any[])[0].text);
    assert.equal(task.id, id);
    const update = await client.callTool({ name: 'update_current', arguments: { expected_updated_at: task.updated_at, set: { PR: 'https://github.com/example/repo/pull/42', '--Flag': 'remove me', Large: 'https://example.com/' + 'x'.repeat(3000) } }, _meta: meta() });
    assert.equal(update.isError, undefined);
    await assert.rejects(act(view, 'done'), /changed/);
    view = await read(); state = view.state;
    assert.ok(view.footer?.some((item) => item.url?.endsWith('/42')));
    const savedConfig = await readFile(config, 'utf8');
    await writeFile(config, JSON.stringify({ unrelated: true, footer: { maxFields: 2, fields: [
      { name: 'PR', label: 'PR', format: '<number>', link: true, width: 3 },
      { name: '--Flag', label: '界界', format: '<value>', link: false, width: 8 },
    ] } }));
    const regularFields = (await read()).footer;
    native = true; scoped = true;
    const compact = await read();
    assert.deepEqual(compact.footer?.[0], { text: '▤ ', openApp: true, width: 3 });
    assert.equal(compact.footer?.[1].action, 'preview');
    assert.equal(compact.footer?.[1].doubleAction, 'done', 'Native double action does not require legacy double-action negotiation');
    assert.ok(compact.footer?.every((item) => item.action !== 'done' && item.action !== 'proposal:accept'));
    assert.equal(compact.footer?.length, 5, 'Split links do not consume another field slot');
    assert.equal(compact.footer?.[3].text, ' ↗');
    assert.ok(compact.footer?.[3].url?.endsWith('/42'));
    assert.equal(compact.footer?.[2].url, undefined);
    assert.ok(visibleWidth(compact.footer![2].text) + visibleWidth(compact.footer![3].text) <= 3);
    assert.ok(visibleWidth(compact.footer![4].text) <= 8);
    const previewed = await act(compact, compact.footer![1].action!);
    assert.match(previewed.preview!, /Details/);
    assert.deepEqual(previewed.view.state, compact.state, 'Single click only previews');
    assert.equal(previewed.view.controls.find((control) => control.id === 'done')?.confirm, undefined, 'Double completion has no extra confirmation');
    native = false; scoped = false;
    assert.deepEqual((await read()).footer, regularFields);
    const linkedFields = Array.from({ length: 64 }, (_, index) => ({ name: `Link${index}`, label: '', format: 'x'.repeat(110), link: true, width: 100 }));
    const current = JSON.parse(((await client.callTool({ name: 'get_current', arguments: {}, _meta: meta() })).content as any[])[0].text);
    assert.equal((await client.callTool({ name: 'update_current', arguments: { expected_updated_at: current.updated_at,
      remove: Object.keys(current.agent_notes), set: Object.fromEntries(linkedFields.map((field) => [field.name, 'https://example.com/pull/42'])) }, _meta: meta() })).isError, undefined);
    await writeFile(config, JSON.stringify({ unrelated: true, footer: { maxFields: 64, fields: linkedFields } }));
    native = true; scoped = true;
    const capped = await read();
    assert.equal(capped.footer?.length, 128, 'Maximum linked fields fit the protocol segment limit');
    for (let index = 2; index < capped.footer!.length; index += 2) {
      assert.equal(capped.footer![index].width, 100, 'Host must not reapply its 60-cell default');
      assert.equal(visibleWidth(capped.footer![index].text), 98);
      assert.equal(capped.footer![index + 1].text, ' ↗', 'Every retained label keeps its link icon');
      assert.ok(capped.footer![index + 1].url);
    }
    const expanded = JSON.parse(((await client.callTool({ name: 'get_current', arguments: {}, _meta: meta() })).content as any[])[0].text);
    assert.equal((await client.callTool({ name: 'update_current', arguments: { expected_updated_at: expanded.updated_at,
      remove: linkedFields.map((field) => field.name), set: current.agent_notes }, _meta: meta() })).isError, undefined);
    native = false; scoped = false;
    await writeFile(config, savedConfig);
    view = (await act(await read(), 'screen:settings')).view;
    assert.equal(view.controls.find((control) => control.id === 'agentGuidance')?.value, 'Custom guidance');
    const staleGuidanceView = view;
    view = (await act(view, 'agentGuidance', 'Updated guidance\nSearch only when asked.')).view;
    assert.equal(JSON.parse(await readFile(config, 'utf8')).agentGuidance, 'Updated guidance\nSearch only when asked.');
    await assert.rejects(act(staleGuidanceView, 'agentGuidance', 'Stale edit'), /changed/);
    const beforeInvalidGuidance = await readFile(config, 'utf8');
    await assert.rejects(act(view, 'agentGuidance', null), /agentGuidance/);
    assert.equal(await readFile(config, 'utf8'), beforeInvalidGuidance);
    view = (await act(view, 'reset-agent-guidance')).view;
    assert.equal(Object.hasOwn(JSON.parse(await readFile(config, 'utf8')), 'agentGuidance'), false);
    assert.equal(JSON.parse(await readFile(config, 'utf8')).unrelated, true);
    assert.match(String(view.controls.find((control) => control.id === 'agentGuidance')?.value), /Search tasks only when the user explicitly asks/);
    assert.ok(!view.controls.some((control) => control.id === 'reset-agent-guidance'));
    view = (await act(view, 'agentGuidance', 'Custom guidance')).view;
    view = (await act(view, 'handoffPrompt', 'Read current task, then wait.')).view;
    assert.equal(JSON.parse(await readFile(config, 'utf8')).unrelated, true);
    assert.equal(JSON.parse(await readFile(config, 'utf8')).agentGuidance, 'Custom guidance');
    await assert.rejects(act(view, 'maxFields', -1), /maxFields/);
    await writeFile(config, JSON.stringify({ ...JSON.parse(await readFile(config, 'utf8')), external: 1 }));
    await assert.rejects(act(view, 'titleWidth', 30), /changed/);
    view = await read(); state = view.state;
    view = (await act(view, 'add-field', 'Next')).view;
    view = (await act(view, 'field:Next')).view;
    view = (await act(view, 'link', false)).view;
    view = (await act(view, 'screen:settings')).view;
    const unicodeName = '😀'.repeat(33);
    view = (await act(view, 'add-field', unicodeName)).view;
    view = (await act(view, `field:${unicodeName}`)).view;
    view = await read(); state = view.state;
    view = (await act(view, 'link', false)).view;
    view = (await act(view, 'screen:settings')).view;
    view = (await act(view, 'add-field', 'Large')).view;
    view = (await act(view, 'field:Large')).view;
    view = (await act(view, 'format', '<value>'.repeat(8))).view;
    assert.ok(view.footer?.some((item) => item.text.includes('example.com') && !item.url));
    const latest = JSON.parse(((await client.callTool({ name: 'get_current', arguments: {}, _meta: meta() })).content as any[])[0].text);
    const removed = await client.callTool({ name: 'update_current', arguments: { expected_updated_at: latest.updated_at, remove: ['--Flag'] }, _meta: meta() });
    assert.equal(removed.isError, undefined);
    view = await read(); state = view.state;
    view = (await act(view, 'screen:tasks')).view;
    assert.equal((await act(view, 'continue')).draft, 'Read current task, then wait.');
    const other = await client.callTool({ name: 'get_current', arguments: {}, _meta: { 'native-ui/context': { conversationId: 'conversation-b', state: {} } } });
    assert.equal((other.content as any[])[0].text, 'null');
    await client.close(); client = await connect();
    view = await read(); assert.equal(view.state.selectedId, id);
    const selected = JSON.parse(((await client.callTool({ name: 'get_current', arguments: {}, _meta: meta() })).content as any[])[0].text);
    const bar = ['x'.repeat(65), ...Array.from({ length: 300 }, (_, i) => `F${i}`)].join('\n');
    assert.equal((await client.callTool({ name: 'update_current', arguments: { expected_updated_at: selected.updated_at, set: { Bar: bar } }, _meta: meta() })).isError, undefined);
    const legacy = JSON.parse(await readFile(config, 'utf8')); legacy.footer.fields = null;
    await writeFile(config, JSON.stringify(legacy));
    view = await read(); state = view.state;
    view = (await act(view, 'screen:settings')).view;
    const derived = view.controls.filter((c) => c.id.startsWith('field:'));
    assert.equal(derived.length, 64);
    assert.ok(derived.every((c) => [...c.id.slice(6)].length <= 64));
    view = (await act(view, 'field:F0')).view;
    view = await read(); state = view.state;
    view = (await act(view, 'screen:tasks')).view;
    view = (await act(view, 'done')).view;
    assert.equal(view.state.selectedId, null);
    view = (await act(view, 'add', '--help')).view;
    view = (await act(view, 'done')).view;
    await promisify(execFile)(join(root, '../.venv/bin/python'), ['-c', 'from pathlib import Path; from pinote.store import Store; import sys\nwith Store(Path(sys.argv[1])) as store:\n for i in range(200): store.add(f"Task {i} " + "x" * 2000)', join(dir, 'pinote/notes.db')]);
    view = await read(); state = view.state;
    assert.ok(view.controls.filter((c) => c.id.startsWith('select:')).length < 200);
    view = (await act(view, 'search', 'Task 199')).view;
    assert.equal(view.controls.filter((c) => c.id.startsWith('select:')).length, 1);
    view = (await act(view, 'search', '')).view;
    const proposal = await client.callTool({ name: 'propose', arguments: { text: 'Suggested task\n\nDetails', tag: 'MCP' }, _meta: meta() });
    assert.equal(proposal.isError, undefined);
    state = proposal._meta!['native-ui/state'] as Record<string, unknown>;
    const first = await read();
    assert.ok(first.footer?.some((item) => item.action === 'proposal:accept'));
    assert.ok(first.footer?.every((item) => item.action !== 'proposal:dismiss' && item.secondaryAction === undefined), 'Legacy hosts use the app menu to dismiss, without a cross');
    const legacyResult = (await act(first, 'screen:settings')).view;
    assert.ok(legacyResult.footer?.every((item) => item.secondaryAction === undefined), 'Legacy action results omit unsupported fields too');
    assert.ok(legacyResult.footer?.every((item) => item.style === undefined && item.doubleAction === undefined));
    styles = true;
    const styled = await read();
    assert.deepEqual(styled.footer?.find((item) => item.text.includes('Suggested task'))?.style, { italic: true, color: 'accent' });
    assert.ok(styled.footer?.every((item) => item.doubleAction === undefined), 'Styles negotiate independently');
    styles = false; double = true;
    const doubleOnly = await read();
    assert.equal(doubleOnly.footer?.find((item) => item.text.includes('Suggested task'))?.doubleAction, 'proposal:accept');
    assert.ok(doubleOnly.footer?.every((item) => item.style === undefined), 'Double actions negotiate independently');
    native = true; styles = true;
    const nativeSuggestion = await read();
    assert.equal(nativeSuggestion.footer?.length, 2);
    assert.match(nativeSuggestion.footer![1].text, /^\? /);
    assert.equal(nativeSuggestion.footer![1].action, undefined, 'Suggestion single click is inert');
    assert.equal(nativeSuggestion.footer![1].doubleAction, 'proposal:accept');
    assert.deepEqual(nativeSuggestion.footer![1].style, { italic: true, color: 'accent' });
    native = false;
    secondary = true; styles = true;
    const clickable = (await act(await read(), 'screen:tasks')).view;
    assert.equal(clickable.footer?.find((item) => item.action === 'proposal:accept')?.secondaryAction, 'proposal:dismiss');
    assert.ok(clickable.footer?.every((item) => item.action !== 'proposal:dismiss'));
    const replaced = await client.callTool({ name: 'propose', arguments: { text: 'Replacement task', tag: 'MCP' }, _meta: meta() });
    const oldState = state;
    state = replaced._meta!['native-ui/state'] as Record<string, unknown>;
    view = await read();
    assert.notEqual(first.revision, view.revision);
    await assert.rejects(act(first, 'proposal:accept'), /changed/);
    native = true; scoped = true;
    view = await read();
    view = (await act(view, view.footer![1].doubleAction!)).view;
    native = false; scoped = false;
    view = await read();
    assert.equal(view.retainOnNew, true);
    const acceptedId = view.state.selectedId;
    assert.equal(typeof acceptedId, 'number');
    const accepted = JSON.parse(((await client.callTool({ name: 'get_current', arguments: {}, _meta: meta() })).content as any[])[0].text);
    assert.equal(accepted.tag, 'MCP');
    assert.equal(accepted.text, 'Replacement task');
    assert.ok(view.footer?.some((item) => item.action === 'preview'));
    assert.ok(view.footer?.some((item) => item.action === 'done'));
    assert.equal(view.footer?.find((item) => item.action === 'preview')?.doubleAction, 'done');
    assert.ok(view.footer?.every((item) => item.style === undefined), 'Accepted titles return to normal text');
    await assert.rejects(act(clickable, 'proposal:accept'), /changed/, 'Accepting double-click cannot be reused to complete');
    assert.equal((await client.callTool({ name: 'propose', arguments: { text: 'Forbidden' }, _meta: meta() })).isError, true);
    native = true; scoped = true;
    view = await read();
    view = (await act(view, view.footer![1].doubleAction!)).view;
    assert.equal(view.state.selectedId, null, 'One native double-click completes immediately');
    assert.equal(view.footer?.[0].openApp, true);
    assert.equal(view.footer?.[1].text, 'Pinote · No task');
    native = false; scoped = false;
    const emptyState = state;
    state = oldState;
    await client.close(); client = await connect();
    assert.equal((await read()).state.proposal, null, 'Replaced proposal cannot be resurrected by branch restore/reconnect');
    state = replaced._meta!['native-ui/state'] as Record<string, unknown>;
    assert.equal((await read()).state.proposal, null, 'Accepted consent cannot be replayed');
    state = emptyState;
    const dismissible = await client.callTool({ name: 'propose', arguments: { text: 'Dismiss me' }, _meta: meta() });
    state = dismissible._meta!['native-ui/state'] as Record<string, unknown>;
    view = (await act(await read(), 'proposal:dismiss')).view;
    assert.equal(view.state.proposal, null);
    assert.equal(view.state.selectedId, null);
    // Negotiated controls only invalidate dependencies of the requested action.
    scoped = true;
    view = await read(); state = view.state;
    assert.ok(view.controls.every((control) => control.revision));
    view = (await act(view, 'search', 'External')).view;
    view = (await act(view, 'add', 'Scoped task')).view;
    const displayed = view;
    const external = async (...args: string[]) => (await promisify(execFile)(join(root, '../.venv/bin/note'), ['--no-notify', ...args], {
      env: { ...process.env, XDG_DATA_HOME: dir, XDG_STATE_HOME: dir },
    })).stdout;
    const observer = await connect();
    const observedChange = async (write: () => Promise<unknown>, matches: (next: any) => boolean, observerState: Record<string, unknown> = {}) => {
      let timeout: ReturnType<typeof setTimeout>;
      const changed = new Promise<void>((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('External write did not notify the other MCP process')), 8000);
        observer.setNotificationHandler(z.object({ method: z.literal('notifications/native-ui/changed'), params: z.object({ uri: z.literal('pinote://ui') }) }), async () => {
          try {
            const result = await observer.readResource({ uri: 'pinote://ui', _meta: { 'native-ui/context': { conversationId: 'observer', state: observerState } } });
            if ('text' in result.contents[0] && matches(JSON.parse(result.contents[0].text))) resolve();
          } catch (error) { reject(error); }
        });
      });
      try { await write(); await changed; } finally { clearTimeout(timeout!); }
    };
    try {
      let other: any;
      await observedChange(async () => { other = JSON.parse(await external('agent', 'add', '--text', 'External task')); },
        (next) => next.controls.some((control: any) => control.id === `select:${other?.id}`), { search: 'External' });
      assert.notEqual((await read()).revision, displayed.revision);
      assert.match((await act(displayed, 'preview')).preview!, /Scoped task/);
      view = (await act(displayed, 'done')).view;
      const selectable = view;
      await external('agent', 'add', '--text', 'Another unrelated task');
      view = (await act(selectable, `select:${other.id}`)).view;
      const selectedView = view;
      let current = JSON.parse(await external('agent', 'get', String(other.id)));
      await external('agent', 'update', String(other.id), '--expected-updated-at', current.updated_at, '--set-json', JSON.stringify({ Bar: 'Before' }));
      const rejected = (error: unknown) => error instanceof McpError && error.code === -33003 &&
        (error.data as any)?.['native-ui/action']?.status === 'not-applied';
      await assert.rejects(act(selectedView, 'done'), rejected);
      assert.match((await act(selectedView, 'preview')).preview!, /Before/);
      view = (await act(await read(), 'screen:settings')).view;
      await external('agent', 'add', '--text', 'Settings must survive this unrelated task');
      view = (await act(view, 'titleWidth', 82)).view;
      const document = JSON.parse(await readFile(config, 'utf8'));
      document.footer.fields = null;
      await observedChange(async () => {
        await writeFile(`${config}.tmp`, JSON.stringify(document)); await rename(`${config}.tmp`, config);
      }, (next) => next.controls.some((control: any) => control.id === 'titleWidth' && control.value === 82), { screen: 'settings' });
      view = await read(); state = view.state;
      view = (await act(view, 'field:Before')).view;
      current = JSON.parse(await external('agent', 'get', String(other.id)));
      await external('agent', 'update', String(other.id), '--expected-updated-at', current.updated_at, '--set-json', JSON.stringify({ Bar: 'Before\nAfter' }));
      await assert.rejects(act(view, 'width', 90), rejected, 'Derived field definitions are part of settings consent');
      assert.equal(JSON.parse(await readFile(config, 'utf8')).footer.fields, null);
      const legacy = await observer.readResource({ uri: 'pinote://ui', _meta: { 'native-ui/context': { conversationId: 'legacy', state: {} } } });
      assert.ok('text' in legacy.contents[0]);
      assert.ok(JSON.parse(legacy.contents[0].text).controls.every((control: any) => control.revision === undefined));
      view = await read(); state = view.state;
      view = (await act(view, 'done')).view;
      const receipt = await client.callTool({ name: 'propose', arguments: { text: 'Cross-process receipt' }, _meta: meta() });
      state = receipt._meta!['native-ui/state'] as Record<string, unknown>;
      view = await read(); state = view.state;
      const pendingState = { ...state };
      await observedChange(() => act(view, 'proposal:dismiss'), (next) => next.state.proposal === null, pendingState);
    } finally { await observer.close(); }
    const saved = await readFile(config, 'utf8');
    await writeFile(config, JSON.stringify({ ...JSON.parse(saved), taskOfferPolicy: null }));
    await assert.rejects(read(), /taskOfferPolicy/);
    assert.equal(JSON.parse(await readFile(config, 'utf8')).taskOfferPolicy, null);
    assert.ok(!(await client.listTools()).tools.some((t) => /settings|action/.test(t.name)), 'UI writes are not model tools');
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
});

test('agent context is complete, read-only, consent-validated and fails closed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pinote-mcp-context-'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const env = { PINOTE_NOTE_COMMAND: join(root, '../.venv/bin/note'), PI_CODING_AGENT_DIR: pathToFileURL(dir).href, XDG_DATA_HOME: dir, XDG_STATE_HOME: dir };
  const cli = async (...args: string[]) => JSON.parse((await promisify(execFile)(env.PINOTE_NOTE_COMMAND, ['--no-notify', ...args], { env: { ...process.env, ...env } })).stdout);
  const client = new Client({ name: 'agent-context-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'dist-mcp/mcp/server.js')], env, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  let state: Record<string, unknown> = {};
  const meta = () => ({ 'native-ui/context': { conversationId: 'context-test', contextId: 'branch-a', state } });
  const read = async () => {
    const result = await client.readResource({ uri: 'pinote://agent-context', _meta: meta() });
    assert.equal(result.contents[0].mimeType, 'application/vnd.mcp-agent-context+json');
    assert.ok('text' in result.contents[0]);
    return z.object({ version: z.literal(1), text: z.string().min(1).max(64_000) }).strict().parse(JSON.parse(result.contents[0].text)).text;
  };
  try {
    await client.connect(transport);
    const entries = (await client.listResources()).resources.filter((entry) => entry.mimeType === 'application/vnd.mcp-agent-context+json');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].description, 'Selected task and handoff notes; otherwise selection status and saved tags.');
    assert.match(await read(), /No task is selected/);
    const task = await cli('agent', 'add', '--text=Original task\n\nComplete task details', '--tag=Saved');
    const updated = await cli('agent', 'update', String(task.id), '--expected-updated-at', task.updated_at, '--set-json', JSON.stringify({ Next: 'Full handoff notes' }));
    state = { selectedId: task.id };
    const selectedText = await read();
    const selectedTask = JSON.parse(selectedText.split('Selected task (complete text, revision and handoff notes):\n')[1].split('\n')[0]);
    assert.deepEqual(selectedTask, { id: task.id, text: task.text, tag: 'Saved', state: task.state, updated_at: updated.updated_at, agent_notes: updated.agent_notes });
    assert.match(selectedText, /Effective handoff field definitions/);
    assert.equal(await read(), selectedText);
    assert.deepEqual(await cli('agent', 'get', String(task.id)), updated, 'Resource reads never mutate the task');
    await t.test('configured guidance replaces the defaults without changing task data or tools', async () => {
      const config = join(dir, 'pi-note.json');
      const tools = await client.listTools();
      const contexts = [];
      for (const selectedId of [task.id, undefined]) {
        state = selectedId ? { selectedId } : {};
        const text = await read();
        assert.match(text, /Search tasks only when the user explicitly asks/);
        const marker = selectedId ? 'Selected task (complete text, revision and handoff notes):' : 'No task is selected';
        contexts.push({ state, data: text.slice(text.indexOf(marker)) });
      }
      for (const guidance of ['Custom guidance.\nSearch freely; keep {task} literal.', '']) {
        await writeFile(config, JSON.stringify({ agentGuidance: guidance }));
        for (const context of contexts) {
          state = context.state;
          assert.equal(await read(), guidance ? `${guidance}\n${context.data}` : context.data);
        }
        assert.deepEqual(await client.listTools(), tools, 'Tool descriptions do not impose a separate policy');
      }
      await writeFile(config, JSON.stringify({ footer: { maxFields: -1 }, agentGuidance: 'Custom guidance' }));
      state = {};
      assert.match(await read(), /^Custom guidance\nNo task is selected/);
      for (const raw of ['{', 'null', ...[null, 42, 'bad\u0000guidance', 'x'.repeat(64_001)].map((agentGuidance) => JSON.stringify({ agentGuidance }))]) {
        await writeFile(config, raw);
        await assert.rejects(read(), /Invalid JSON|expected an object|agentGuidance/);
        assert.equal(await readFile(config, 'utf8'), raw);
        assert.deepEqual(await client.listTools(), tools, 'Invalid guidance does not block tool discovery');
      }
      await rm(config);
      assert.match(await read(), /Search tasks only when the user explicitly asks/);
    });
    state = {};
    assert.match(await read(), /Saved tags:\n\["Saved"\]/);
    const suggest = async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: 'propose', arguments: args, _meta: meta() });
      assert.equal(result.isError, undefined);
      state = result._meta!['native-ui/state'] as Record<string, unknown>;
    };
    await suggest({ text: 'Pending new work', tag: 'Saved' });
    assert.match(await read(), /Pending new work/);
    const oldState = state;
    await suggest({ task_id: task.id });
    assert.match(await read(), /"task_id":/);
    assert.match(await read(), /Complete task details/);
    const existingState = state;
    state = oldState;
    assert.match(await read(), /Pending suggestion \(not selected\):\nnull/, 'Consumed proposals stay hidden');
    state = existingState;
    await cli('agent', 'done', String(task.id), '--expected-updated-at', updated.updated_at);
    assert.match(await read(), /Pending suggestion \(not selected\):\nnull/, 'Completed suggestions stay hidden');
    state = { selectedId: task.id };
    assert.match(await read(), /No task is selected/);
    state = { selectedId: 999999 };
    await assert.rejects(read(), /agent get 999999/, 'Missing target CLI errors propagate, as in get_current');
    state = { selectedId: -1 };
    await assert.rejects(read());
    state = {};
    await assert.rejects(client.readResource({ uri: 'pinote://agent-context' }), /./, 'Missing host context is an error');
    // Simulate oversized legacy/imported data in the same database (normal writes are bounded).
    const large = await cli('agent', 'add', '--text=Oversized legacy task');
    await promisify(execFile)(join(root, '../.venv/bin/python'), ['-c', 'import sqlite3, sys\nwith sqlite3.connect(sys.argv[1]) as db:\n db.execute("UPDATE notes SET text = ? WHERE id = ?", ("x" * 65000, int(sys.argv[2])))', join(dir, 'pinote/notes.db'), String(large.id)]);
    state = { selectedId: large.id };
    await assert.rejects(read(), /exceeds 64000/);
    await rename(join(dir, 'pinote/notes.db'), join(dir, 'pinote/backup.db'));
    await writeFile(join(dir, 'pinote/notes.db'), 'not a database');
    state = { selectedId: task.id };
    await assert.rejects(read(), /./, 'Read failure must not become no selection');
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
