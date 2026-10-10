import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { defaultFooterField, defaultHandoffPrompt, defaultNewSessionPrompt, effectiveFooterFields, parseHandoffPrompt, parseNewSessionPrompt, readFooterDocument, saveFooterConfig } from '../footer-config.ts';

const URI = 'pinote://ui';
const MIME = 'application/vnd.mcp-native-ui+json';
const CONTEXT = 'native-ui/context';
const exec = promisify(execFile);
const noteCommand = process.env.PINOTE_NOTE_COMMAND || 'note';
const icons = Object.fromEntries(['add', 'check', 'note'].map((name) => [name, readFileSync(new URL(`../icons/${name}.txt`, import.meta.url), 'utf8').trim()]));
const Context = z.object({ conversationId: z.string().min(1).max(256), state: z.object({
  selectedId: z.number().int().positive().safe().nullable().optional(), screen: z.enum(['tasks', 'settings', 'field']).optional(),
  field: z.string().max(64).optional(), search: z.string().max(256).optional(),
}).default({}) });
type State = z.infer<typeof Context>['state'];
type Task = { id: number; text: string; state: string; tag: string | null; updated_at: string; agent_notes: Record<string, string> };
type Scalar = string | number | boolean | null;
type Control = { id: string; label: string; kind: 'action' | 'text' | 'number' | 'toggle' | 'select'; value?: Scalar; icon?: string; description?: string; multiline?: boolean; confirm?: string; options?: { label: string; value: Scalar }[] };
const Action = z.object({ method: z.literal('native-ui/action'), params: z.object({
  uri: z.literal(URI), revision: z.string().min(1).max(256), action: z.string().min(1).max(256),
  value: z.union([z.string().max(20_000), z.number().finite(), z.boolean(), z.null()]).optional(), _meta: z.record(z.unknown()).optional(),
}) });
const server = new Server({ name: 'pinote', version: '0.19.0' }, { capabilities: { tools: {}, resources: {}, experimental: { 'native-ui-v1': {} } } });
// Serialize complete read/check/write cycles even when a host sends parallel calls.
let queue = Promise.resolve();
function serial<T>(run: () => Promise<T>): Promise<T> {
  const result = queue.then(run);
  queue = result.then(() => {}, () => {});
  return result;
}
function context(meta: Record<string, unknown> | undefined) { return Context.parse(meta?.[CONTEXT]); }
async function note(args: string[], signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const options = { signal, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 };
  const version = (await exec(noteCommand, ['--version'], options)).stdout.trim();
  const match = /^pinote (\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || Number(match[1]) === 0 && Number(match[2]) < 4) throw new Error('Pinote MCP requires note 0.4.0+');
  return (await exec(noteCommand, ['--no-notify', ...args], options)).stdout;
}
async function selected(state: State, signal: AbortSignal): Promise<Task | null> {
  if (!state.selectedId) return null;
  const task: Task | null = JSON.parse(await note(['agent', 'get', String(state.selectedId)], signal));
  return task && ['active', 'in_progress'].includes(task.state) ? task : null;
}
function settings() {
  const document = readFooterDocument();
  const root = document.raw === null ? {} : JSON.parse(document.raw);
  const handoffPrompt = 'handoffPrompt' in root ? parseHandoffPrompt(root.handoffPrompt) : defaultHandoffPrompt;
  const newSessionPrompt = 'newSessionPrompt' in root ? parseNewSessionPrompt(root.newSessionPrompt) : defaultNewSessionPrompt;
  const policy = root.taskOfferPolicy ?? 'always';
  if (!['always', 'github-remote', 'never'].includes(policy)) throw new Error('Invalid taskOfferPolicy in pi-note.json');
  return { ...document, handoffPrompt, newSessionPrompt, policy };
}
async function snapshot(state: State, signal: AbortSignal) {
  const tasks: Task[] = JSON.parse(await note(['list', '--json'], signal));
  const task = await selected(state, signal);
  const config = settings();
  state = { ...state, selectedId: task?.id ?? null };
  if (state.screen === 'field' && !effectiveFooterFields(config.config, task?.agent_notes).some((f) => f.name === state.field)) state.screen = 'settings';
  const revision = createHash('sha256').update(JSON.stringify({ state, tasks, task, raw: config.raw })).digest('hex');
  return { state, tasks, task, config, revision };
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
function view(data: Snapshot) {
  const { tasks, task, config, revision } = data;
  const state: State = { ...data.state, selectedId: task?.id ?? null };
  const controls: Control[] = [];
  const action = (id: string, label: string, extra: Partial<Control> = {}) => controls.push({ id, label: label.slice(0, 2000), kind: 'action', ...extra });
  let title = 'Pinote · Tasks';
  let body = task ? task.text : 'Select a task or create one. No task is selected for this conversation.';
  action('screen:tasks', 'Tasks', { icon: icons.note });
  action('screen:settings', 'Settings', { description: 'Global prompts, task offers, and footer fields' });
  if (state.screen === 'settings') {
    title = 'Pinote · Settings'; body = 'Personal pi-note.json · changes save after confirmation';
    for (const [id, label, value] of [['handoffPrompt', 'Task prompt', config.handoffPrompt], ['newSessionPrompt', 'New session prompt', config.newSessionPrompt]] as const) {
      controls.push({ id, label, value, kind: 'text', multiline: true, confirm: 'Save this global prompt?' });
    }
    controls.push({ id: 'taskOfferPolicy', label: 'Task offers', kind: 'select', value: config.policy, options: ['always', 'github-remote', 'never'].map((value) => ({ label: value, value })), confirm: 'Save this global task-offer policy?' });
    for (const key of ['titleWidth', 'fieldWidth', 'maxFields'] as const) controls.push({ id: key, label: key, kind: 'number', value: config.config[key], confirm: 'Save this global footer setting?' });
    controls.push({ id: 'add-field', label: 'Add field', icon: icons.add, kind: 'text', value: '', confirm: 'Add this global footer field?' });
    effectiveFooterFields(config.config, task?.agent_notes).forEach((field) => action(`field:${field.name}`, field.name, { description: `${field.label || '(no label)'} · ${field.format}` }));
  } else if (state.screen === 'field') {
    const field = effectiveFooterFields(config.config, task?.agent_notes).find((f) => f.name === state.field);
    if (!field) throw new Error('Field no longer exists; open Settings again');
    title = `Pinote · ${field.name}`; body = 'Global footer display definition; task values are unchanged.';
    controls.push({ id: 'label', label: 'Label', kind: 'text', value: field.label, confirm: 'Save this global field label?' });
    controls.push({ id: 'format', label: 'Format', kind: 'text', value: field.format, description: '<value>, <url>, <number>', confirm: 'Save this global field format?' });
    controls.push({ id: 'width', label: 'Width', kind: 'number', value: field.width ?? config.config.fieldWidth, confirm: 'Save this global field width?' });
    controls.push({ id: 'link', label: 'Link', kind: 'toggle', value: field.link, confirm: 'Change this global link setting?' });
    action('remove-field', 'Remove field', { confirm: 'Remove this global display definition? Task values are retained.' });
  } else {
    if (task) {
      action('continue', 'Continue', { description: 'Request insertion of the task prompt; never submit it' });
      action('preview', 'Preview full task', { description: 'Read-only local preview; never sent to the model' });
      action('done', 'Complete task', { icon: icons.check, confirm: 'Complete this task? This does not start a new conversation.' });
      action('clear', 'Clear selection', { description: 'Keep the task and its progress unchanged' });
    }
    controls.push({ id: 'add', label: 'New task', icon: icons.add, kind: 'text', multiline: true, value: '', confirm: 'Create and select this task?' });
    controls.push({ id: 'search', label: 'Filter tasks', kind: 'text', value: state.search ?? '' });
    const matches = tasks.filter((t) => `${t.text} ${t.tag ?? ''}`.toLowerCase().includes((state.search ?? '').toLowerCase()));
    for (const candidate of matches.slice(0, 200)) action(`select:${candidate.id}`, `${candidate.tag ? `[${candidate.tag}] ` : ''}${candidate.text.split('\n')[0]}`, { description: `#${candidate.id} · ${candidate.state}`, confirm: 'Select and start this task for this conversation?' });
    if (matches.length > 200) body += '\nShowing the first 200 matches; use Filter tasks to narrow the list.';
  }
  const footer: { text: string; url?: string; width?: number }[] = [{ text: `${icons.note} ${task ? task.text.split('\n')[0].slice(0, 2000) : 'Pinote · no task'}`, width: config.config.titleWidth }];
  if (task) {
    for (const field of effectiveFooterFields(config.config, task.agent_notes)) {
      if (footer.length - 1 >= config.config.maxFields) break;
      const raw = task.agent_notes[field.name];
      if (!raw) continue;
      const link = /^\[([^\n]*)\]\((https?:\/\/[^\s]+)\)$/.exec(raw);
      const url = link?.[2] ?? (/^https?:\/\/[^\s]+$/.test(raw) ? raw : undefined);
      const value = link?.[1] ?? raw;
      const number = url?.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)\/?$/)?.[1] ?? (/^\d+$/.test(value) ? value : undefined);
      if (field.format.includes('<url>') && !url || field.format.includes('<number>') && !number) continue;
      footer.push({ text: ` · ${field.label ? `${field.label}: ` : ''}${field.format.replaceAll('<value>', value).replaceAll('<url>', url ?? '').replaceAll('<number>', number ?? '')}`, ...(field.link && url ? { url } : {}), width: field.width ?? config.config.fieldWidth });
    }
  }
  return { version: 1, title, body: body.slice(0, 20_000), revision, state, controls, footer };
}
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: URI, name: 'Pinote', mimeType: MIME }] }));
server.setRequestHandler(ReadResourceRequestSchema, (request, extra) => serial(async () => {
  if (request.params.uri !== URI) throw new Error('Unknown resource');
  const data = await snapshot(context(request.params._meta).state, extra.signal);
  return { contents: [{ uri: URI, mimeType: MIME, text: JSON.stringify(view(data)) }] };
}));
server.setRequestHandler(Action, (request, extra) => serial(async () => {
  const state = context(request.params._meta).state;
  const before = await snapshot(state, extra.signal);
  if (before.revision !== request.params.revision) throw new Error('View changed; refresh before acting');
  const { action, value } = request.params;
  if (!view(before).controls.some((c) => c.id === action)) throw new Error('Action is not available in this view');
  const next: State = { ...state };
  let draft: string | undefined, preview: string | undefined;
  if (action.startsWith('screen:')) next.screen = action.slice(7) as State['screen'];
  else if (action.startsWith('field:')) { next.screen = 'field'; next.field = action.slice(6); }
  else if (action === 'search') next.search = z.string().max(256).parse(value);
  else if (action === 'clear') next.selectedId = null;
  else if (action === 'continue') draft = before.config.handoffPrompt;
  else if (action === 'preview') preview = (before.task!.text + '\n\n' + JSON.stringify(before.task!.agent_notes, null, 2)).slice(0, 20_000);
  else if (action.startsWith('select:')) {
    const id = Number(action.slice(7));
    if (!before.tasks.some((t) => t.id === id)) throw new Error('Task no longer selectable');
    await note(['start', String(id)], extra.signal); next.selectedId = id;
  } else if (action === 'add') {
    const task: Task = JSON.parse(await note(['agent', 'add', '--text', z.string().min(1).parse(value)], extra.signal));
    await note(['start', String(task.id)], extra.signal); next.selectedId = task.id;
  } else if (action === 'done') {
    await note(['agent', 'done', String(before.task!.id), '--expected-updated-at', before.task!.updated_at], extra.signal);
    next.selectedId = null;
  } else {
    const cfg = structuredClone(before.config.config);
    let handoff = before.config.handoffPrompt, newSession = before.config.newSessionPrompt, policy = before.config.policy;
    if (action === 'handoffPrompt') handoff = z.string().parse(value);
    else if (action === 'newSessionPrompt') newSession = z.string().parse(value);
    else if (action === 'taskOfferPolicy') policy = z.enum(['always', 'github-remote', 'never']).parse(value);
    else if (['titleWidth', 'fieldWidth', 'maxFields'].includes(action)) cfg[action as 'titleWidth'] = z.number().int().parse(value);
    else {
      cfg.fields = effectiveFooterFields(cfg, before.task?.agent_notes);
      if (action === 'add-field') cfg.fields.push(defaultFooterField(z.string().parse(value)));
      else if (action === 'remove-field') { cfg.fields = cfg.fields.filter((f) => f.name !== state.field); next.screen = 'settings'; }
      else {
        const field = cfg.fields.find((f) => f.name === state.field)!;
        if (action === 'link') field.link = z.boolean().parse(value);
        else if (action === 'width') field.width = z.number().int().parse(value);
        else if (action === 'label' || action === 'format') field[action] = z.string().parse(value);
        else throw new Error('Unknown action');
      }
    }
    extra.signal.throwIfAborted();
    saveFooterConfig(cfg, before.config.raw, handoff, newSession, policy);
  }
  const result = { view: view(await snapshot(next, extra.signal)), ...(draft ? { draft } : {}), ...(preview ? { preview } : {}) };
  await server.notification({ method: 'notifications/native-ui/changed', params: { uri: URI } });
  return result;
}));
const empty = { type: 'object' as const, properties: {}, additionalProperties: false };
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'get_current', description: 'Read the task selected through the native Pinote UI for this conversation. Returns null if unselected.', inputSchema: empty, annotations: { readOnlyHint: true } },
  { name: 'fields', description: 'Read global footer field definitions before setting task handoff values. Does not edit settings.', inputSchema: empty, annotations: { readOnlyHint: true } },
  { name: 'tags', description: 'List saved Pinote tags.', inputSchema: empty, annotations: { readOnlyHint: true } },
  { name: 'update_current', description: 'Merge Markdown handoff fields on the selected task. Read get_current first. Keep handoff notes concise; PR is one GitHub PR URL.', inputSchema: { type: 'object' as const, properties: { expected_updated_at: { type: 'string' }, set: { type: 'object', additionalProperties: { type: 'string' } }, remove: { type: 'array', items: { type: 'string' } } }, required: ['expected_updated_at'], additionalProperties: false } },
] }));
server.setRequestHandler(CallToolRequestSchema, (request, extra) => serial(async () => {
  try {
    const state = context(request.params._meta).state;
    let result: unknown;
    if (request.params.name === 'get_current') result = await selected(state, extra.signal);
    else if (request.params.name === 'fields') result = settings().config;
    else if (request.params.name === 'tags') result = JSON.parse(await note(['agent', 'tags'], extra.signal));
    else if (request.params.name === 'update_current') {
      const args = z.object({ expected_updated_at: z.string(), set: z.record(z.string()).default({}), remove: z.array(z.string()).default([]) }).strict().parse(request.params.arguments);
      const task = await selected(state, extra.signal);
      if (!task) throw new Error('No task is selected');
      result = JSON.parse(await note(['agent', 'update', String(task.id), '--expected-updated-at', args.expected_updated_at, '--set-json', JSON.stringify(args.set), ...args.remove.flatMap((key) => ['--remove', key])], extra.signal));
      await server.notification({ method: 'notifications/native-ui/changed', params: { uri: URI } });
    } else throw new Error('Unknown tool');
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: String(error) }] }; }
}));
await server.connect(new StdioServerTransport());
