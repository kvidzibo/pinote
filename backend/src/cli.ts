import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Store, NoteError, type Note } from './store.ts';
import { markdown as noteMarkdown, validate_tag, validate_text, validateAgentPatch, validatePiSession, timestamp, pythonStrip } from './compat.ts';
import { parse_reminder_time, local_reminder_time } from './reminders.ts';
import { VERSION, discoverPaths, configureLogging, log, jsonStringify, withDisplayLock, checkCancelled, type Paths } from './runtime.ts';
import * as markdown from './markdown.ts';
import * as notify from './notify.ts';

const COMMANDS = new Set(['add', 'list', 'done', 'start', 'rm', 'restore', 'history', 'events', 'field-events', 'show', 'import', 'export', 'schedule', 'reminders', 'agent']);
const MUTATIONS = new Set(['add', 'done', 'start', 'rm', 'restore', 'import', 'schedule']);
class ArgumentError extends Error {}
export function positive_id(value: string): bigint {
  // int() accepts signs, surrounding whitespace and digit separators.
  // Unicode Nd blocks are consecutive sets of ten decimal digits (some
  // mathematical alphabets place several sets directly next to one another).
  const trimmed = pythonStrip(value);
  if (!/^[+-]?\p{Nd}(?:_?\p{Nd})*$/u.test(trimmed)) throw new ArgumentError('ID must be a positive integer');
  const ascii = [...trimmed.replaceAll('_', '')].map(char => {
    if (!/\p{Nd}/u.test(char)) return char;
    const cp = char.codePointAt(0)!;
    let start = cp;
    while (start > 0 && /\p{Nd}/u.test(String.fromCodePoint(start - 1))) start--;
    return String((cp - start) % 10);
  }).join('');
  const id = BigInt(ascii);
  if (id < 1n || id > 9223372036854775807n) throw new ArgumentError('ID must be a positive SQLite integer');
  return id;
}
export function event_cursor(value: string): bigint {
  if (!/^[0-9]{1,16}$/.test(value) || BigInt(value) > 9007199254740991n) throw new ArgumentError('Cursor must be a nonnegative safe integer');
  return BigInt(value);
}
export function event_limit(value: string): number {
  const limit = event_cursor(value);
  if (limit < 1n || limit > 1000n) throw new ArgumentError('Limit must be between 1 and 1000');
  return Number(limit);
}
export interface Arguments {
  command: string; no_notify: boolean; agent_action?: string; id?: bigint;
  text?: string[]; when?: string; path?: string; all?: boolean; json?: boolean;
  after?: bigint; limit: number; cwd?: string; expected_updated_at?: string;
  pi_session_id?: string; set_json: string; remove: string[]; tag?: string; clear?: boolean;
  help?: boolean; version?: boolean; agent_text?: string;
}
export function arguments_(input: string[]): Arguments {
  let argv = [...input];
  const args: Arguments = { command: 'list', no_notify: false, limit: 256, set_json: '{}', remove: [] };
  while (argv[0] === '--no-notify') { args.no_notify = true; argv.shift(); }
  if (!argv.length) argv = ['list'];
  else if (!COMMANDS.has(argv[0]) && !['-h', '--help', '--version'].includes(argv[0])) argv.unshift('add');
  if (argv[0] === '--version') { args.version = true; return args; }
  if (['-h', '--help'].includes(argv[0])) { args.help = true; return args; }
  args.command = argv.shift()!;
  // --no-notify belongs to the agent parser, not its action parser.
  while (argv[0] === '--no-notify') { args.no_notify = true; argv.shift(); }
  if (args.command === 'agent') {
    if (['-h', '--help'].includes(argv[0])) { args.help = true; return args; }
    args.agent_action = argv.shift();
    if (!['get', 'selected', 'select', 'start', 'update', 'done', 'add', 'tag', 'tags'].includes(args.agent_action ?? '')) throw new ArgumentError('the following arguments are required: agent_action');
  }
  const positionals: string[] = [];
  const allowed = new Set<string>(args.command === 'agent' ? [] : ['--no-notify']);
  const values = new Set<string>();
  const allowValue = (...names: string[]) => { for (const name of names) { allowed.add(name); values.add(name); } };
  if (['events', 'field-events'].includes(args.command)) allowValue('--after', '--limit');
  if (['list', 'export'].includes(args.command)) allowed.add('--all');
  if (args.command === 'list') allowed.add('--json');
  if (args.command === 'agent') {
    const action = args.agent_action!;
    if (['selected', 'select', 'add'].includes(action)) allowValue('--cwd');
    if (['start', 'update', 'done', 'tag'].includes(action)) allowValue('--expected-updated-at');
    if (action === 'start') allowValue('--pi-session-id');
    if (action === 'update') allowValue('--set-json', '--remove');
    if (action === 'add') allowValue('--text', '--tag');
    if (action === 'tag') { allowValue('--tag'); allowed.add('--clear'); }
  }
  let literal = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && ['-h', '--help'].includes(token)) { args.help = true; return args; }
    if (!literal && token.startsWith('-') && !/^-[0-9]/.test(token)) {
      const equal = token.indexOf('=');
      const key = equal < 0 ? token : token.slice(0, equal);
      if (!allowed.has(key)) throw new ArgumentError(`unrecognized arguments: ${token}`);
      let value: string | undefined;
      if (values.has(key)) {
        value = equal < 0 ? argv[++i] : token.slice(equal + 1);
        if (value === undefined || (equal < 0 && /^--/.test(value))) throw new ArgumentError(`argument ${key}: expected one argument`);
      } else if (equal >= 0) throw new ArgumentError(`argument ${key}: ignored explicit argument '${token.slice(equal + 1)}'`);
      switch (key) {
        case '--no-notify': args.no_notify = true; break;
        case '--json': args.json = true; break;
        case '--all': args.all = true; break;
        case '--clear': args.clear = true; break;
        case '--after': args.after = event_cursor(value!); break;
        case '--limit': args.limit = event_limit(value!); break;
        case '--remove': args.remove.push(value!); break;
        case '--text': args.agent_text = value; break;
        default: (args as unknown as Record<string, unknown>)[key.slice(2).replaceAll('-', '_')] = value;
      }
    } else positionals.push(token);
  }
  const requireOption = (key: keyof Arguments, name: string) => { if (args[key] === undefined) throw new ArgumentError(`the following arguments are required: ${name}`); };
  let count = 0, optional = false;
  if (args.command === 'add') { if (!positionals.length) throw new ArgumentError('the following arguments are required: text'); args.text = positionals; return args; }
  if (['done', 'start', 'rm', 'restore', 'history', 'schedule'].includes(args.command)) { count = args.command === 'schedule' ? 2 : 1; optional = args.command === 'history'; }
  if (args.command === 'import') count = 1;
  if (args.command === 'agent') {
    const action = args.agent_action!;
    count = ['selected', 'add', 'tags'].includes(action) ? 0 : 1;
    if (['select', 'selected'].includes(action)) requireOption('cwd', '--cwd');
    if (['start', 'update', 'done', 'tag'].includes(action)) requireOption('expected_updated_at', '--expected-updated-at');
    if (action === 'add') requireOption('agent_text', '--text');
    if (action === 'tag' && (args.clear ? args.tag !== undefined : args.tag === undefined)) throw new ArgumentError('one of the arguments --tag --clear is required (and mutually exclusive)');
  }
  if (positionals.length > count) throw new ArgumentError(`unrecognized arguments: ${positionals.slice(count).join(' ')}`);
  if (positionals.length < count && !optional) throw new ArgumentError(`the following arguments are required: ${args.command === 'import' ? 'path' : positionals.length ? 'when' : 'id'}`);
  if (args.command === 'import') args.path = positionals[0];
  else if (positionals.length) { args.id = positive_id(positionals[0]); if (args.command === 'schedule') args.when = positionals[1]; }
  return args;
}
export { arguments_ as arguments };
export function agent_task(note: Note | null): unknown {
  return note === null ? null : { id: note.id, text: note.text, state: note.state, tag: note.tag, updated_at: note.updated_at, agent_notes: note.agent_notes, 'pi-sessions': note.pi_sessions, markdown: noteMarkdown(note) };
}
function explicitTag(value: string): string {
  const tag = validate_tag(value);
  if (tag === null) throw new NoteError('Tag names cannot be empty.');
  return tag;
}
const print = (value: string) => process.stdout.write(value + '\n');
function parseAgentFields(value: string): unknown {
  try { return JSON.parse(value); } catch { throw new NoteError('--set-json must contain a JSON object of label: Markdown pairs.'); }
}
function validateCommand(args: Arguments): void {
  if (args.command === 'add') validate_text(args.text!.join(' '));
  if (args.command === 'schedule' && parse_reminder_time(args.when!) <= timestamp()) throw new NoteError('Choose a reminder time in the future.');
  if (args.command !== 'agent') return;
  validatePiSession(args.pi_session_id);
  if (args.cwd !== undefined && !isAbsolute(args.cwd)) throw new NoteError('--cwd must be an absolute project directory.');
  if (args.tag !== undefined) explicitTag(args.tag);
  if (args.agent_action === 'add') validate_text(args.agent_text!);
  if (args.agent_action === 'update') validateAgentPatch(parseAgentFields(args.set_json), args.remove);
}
export function execute_agent(args: Arguments, store: Store): void {
  const action = args.agent_action!;
  if (['select', 'selected'].includes(action) && !isAbsolute(args.cwd!)) throw new NoteError('--cwd must be an absolute project directory.');
  if (action === 'tags') { print(jsonStringify(store.tags())); return; }
  let note: Note | null;
  if (action === 'selected') note = store.selected(args.cwd!);
  else if (action === 'select') note = store.select(args.id!, args.cwd!);
  else if (action === 'update') {
    const fields = parseAgentFields(args.set_json);
    note = store.update_agent(args.id!, fields as Record<string, string>, args.remove, { expected_updated_at: args.expected_updated_at! });
  } else if (action === 'start' || action === 'done') {
    if (!store.transition(args.id!, action, { expected_states: new Set(['active', 'in_progress']), expected_updated_at: args.expected_updated_at!, allow_unchanged: action === 'start', pi_session_id: action === 'start' ? args.pi_session_id : undefined })) throw new NoteError('This task changed elsewhere. Read it again before acting.');
    note = store.get(args.id!);
  } else if (action === 'add') note = store.add_note(args.agent_text!, { tag: args.tag === undefined ? null : explicitTag(args.tag), cwd: args.cwd });
  else if (action === 'tag') {
    store.set_tag(args.id!, args.clear ? null : explicitTag(args.tag!), { expected_updated_at: args.expected_updated_at! });
    note = store.get(args.id!);
  } else note = store.get(args.id!);
  print(jsonStringify(agent_task(note)));
}
// Python repr's quote selection is visible in history output.
function repr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let result = quote;
  for (const char of value) {
    const cp = char.codePointAt(0)!;
    if (char === quote || char === '\\') result += '\\' + char;
    else if (char === '\n') result += '\\n';
    else if (char === '\r') result += '\\r';
    else if (char === '\t') result += '\\t';
    else if (/\p{C}|\p{Zl}|\p{Zp}|\p{Zs}/u.test(char) && char !== ' ') result += cp <= 255 ? '\\x' + cp.toString(16).padStart(2, '0') : cp <= 65535 ? '\\u' + cp.toString(16).padStart(4, '0') : '\\U' + cp.toString(16).padStart(8, '0');
    else result += char;
  }
  return result + quote;
}
export async function execute(args: Arguments, paths: Paths): Promise<number> {
  const scheduled = args.command === 'schedule' ? parse_reminder_time(args.when!) : undefined;
  const needsLock = MUTATIONS.has(args.command) || args.command === 'show' || args.command === 'agent' && ['select', 'start', 'update', 'done', 'add', 'tag'].includes(args.agent_action!);
  const run = async () => {
    checkCancelled();
    const store = new Store(paths.database);
    try {
      if (needsLock) store.activate_due();
      else if (!['events', 'field-events'].includes(args.command) && store.has_due()) await withDisplayLock(paths, true, () => { store.activate_due(); });
      switch (args.command) {
        case 'agent': execute_agent(args, store); break;
        case 'add': print(`Added note ${store.add(args.text!.join(' '))}.`); break;
        case 'schedule': { const changed = store.schedule(args.id!, scheduled!); print(`Note ${args.id} ${changed ? 'scheduled' : 'already scheduled'} for ${local_reminder_time(scheduled!)}.`); break; }
        case 'reminders': {
          const notes = store.scheduled_notes();
          for (const note of notes) print(`${note.id}. ${local_reminder_time(note.remind_at!)} ${noteMarkdown(note).replaceAll('\n', '\n    ')}`);
          if (!notes.length) print('No scheduled reminders.'); break;
        }
        case 'done': case 'start': case 'rm': case 'restore': {
          const changed = store.transition(args.id!, args.command);
          const state = { done: 'done', start: 'in progress', rm: 'removed', restore: 'active' }[args.command];
          print(changed ? `Note ${args.id}: ${state}.` : `Note ${args.id} is already ${state}.`); break;
        }
        case 'list': {
          const notes = store.notes({ all_states: args.all });
          if (args.json) print(jsonStringify(notes.map(({ id, text, state, tag }) => ({ id, text, state, tag }))));
          else {
            for (const note of notes) print(`${note.id}. ${args.all || note.state === 'in_progress' ? `[${note.state.replaceAll('_', ' ')}] ` : ''}${noteMarkdown(note).replaceAll('\n', '\n    ')}${note.remind_at ? ` (${local_reminder_time(note.remind_at)})` : ''}`);
            if (!notes.length) print(args.all ? 'No notes.' : 'No active notes.');
          } break;
        }
        case 'events': print(jsonStringify(store.completion_events(args.after, args.limit))); break;
        case 'field-events': print(jsonStringify(store.field_events(args.after, args.limit))); break;
        case 'history': {
          const events = store.history(args.id);
          for (const event of events) {
            let text = event.text.replaceAll('\n', '\\n');
            if (event.action === 'edit') text = `${repr(event.previous_text)} -> ${repr(event.text)}`;
            else if (event.action === 'agent') text = `agent ${event.previous_agent_notes} -> ${event.agent_notes}`;
            else if (event.action === 'tag') text = `tag ${event.previous_tag ? repr(event.previous_tag) : 'Untagged'} -> ${event.tag ? repr(event.tag) : 'Untagged'}  ${text}`;
            else if (event.remind_at || event.previous_remind_at) text = `reminder ${event.previous_remind_at ? local_reminder_time(event.previous_remind_at) : 'none'} -> ${event.remind_at ? local_reminder_time(event.remind_at) : 'none'}  ${text}`;
            print(`${event.occurred_at}  #${event.note_id}  ${event.action}  ${event.previous_state || 'new'} -> ${event.state}  ${text}`);
          }
          if (!events.length) print('No history.'); break;
        }
        case 'import': {
          const path = args.path === '~' ? homedir() : args.path!.startsWith('~/') ? join(homedir(), args.path!.slice(2)) : args.path!;
          const source = realpathSync(path);
          const entries = markdown.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(source)).replace(/\r\n?/g, '\n'));
          const summary = store.import_notes(source, entries);
          print(summary === null ? 'Source already imported; nothing added.' : `Imported ${summary.notes} notes. Tags created: ${summary.tags}.`); break;
        }
        case 'export': process.stdout.write(markdown.export(store.notes({ all_states: args.all }))); break;
      }
      // Every Store mutation is synchronously committed before desktop delivery.
      if (MUTATIONS.has(args.command) && !args.no_notify || args.command === 'show') {
        try { await notify.show(store.notes()); checkCancelled(); }
        catch (error) {
          checkCancelled();
          if (!(error instanceof notify.NotificationError)) throw error;
          if (args.command === 'show') { log('error', error.message); return 1; }
          log('warning', `Notes saved, but desktop refresh failed: ${error.message}`);
        }
      }
      return 0;
    } finally { store.close(); }
  };
  return needsLock ? withDisplayLock(paths, true, run) : run();
}
function help(args: Arguments): string {
  const descriptions: Record<string, string> = {
    add: 'add a note (also the default for text arguments)\n  text ...  note text; quote shell metacharacters',
    list: 'list active notes\n  --json  emit notes as a JSON array\n  --all   include all states',
    done: 'mark a note done\n  id  positive note ID', start: 'mark a note in progress\n  id  positive note ID',
    rm: 'archive a note without erasing history\n  id  positive note ID',
    restore: 'return an archived/scheduled note to active, or clear progress\n  id  positive note ID',
    history: 'show timestamped activity, optionally for one note\n  [id]  positive note ID',
    events: 'read bounded task-completion events as JSON\n  --after CURSOR\n  --limit LIMIT  1–1000 (default: 256)',
    'field-events': 'read bounded active field changes as JSON\n  --after CURSOR\n  --limit LIMIT  1–1000 (default: 256)',
    show: 'show or reopen the desktop reminder', import: 'import a Markdown file once, without changing it\n  path  Markdown file',
    export: 'write active notes as Markdown to stdout\n  --all  include active/in-progress/done notes',
    schedule: 'schedule a reminder for a note\n  id\n  when  local time or ISO time, e.g. "2030-01-02 09:30"',
    reminders: 'list scheduled reminders',
    agent: 'add/tag tasks and read/update agent fields (JSON, no desktop refresh)\n  {get,selected,select,start,update,done,add,tag,tags}\n  get ID\n  selected --cwd CWD\n  select ID --cwd CWD\n  start ID --expected-updated-at REVISION [--pi-session-id SESSION]\n  update ID --expected-updated-at REVISION [--set-json JSON] [--remove LABEL ...]\n  done ID --expected-updated-at REVISION\n  add --text TEXT [--tag TAG] [--cwd CWD]\n  tag ID --expected-updated-at REVISION (--tag TAG | --clear)\n  tags',
  };
  return `usage: note [--version] [--no-notify] COMMAND ...\n\nPinned desktop reminders with stable IDs and durable history.\n\nCommands:\n${[...COMMANDS].map(command => `  ${command}  ${descriptions[command].split('\n')[0]}`).join('\n')}\n\n${args.command}: ${descriptions[args.command]}\n\nOptions:\n  -h, --help  show this help message and exit\n  --version   show program's version number and exit\n  --no-notify skip automatic desktop refresh\n\nShortcuts: note lists active notes; note "some text" adds a note. Use note add "done" for text matching a command name.`;
}
export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: Arguments;
  try { args = arguments_(argv); }
  catch (error) { process.stderr.write(`usage: note [--version] [--no-notify] COMMAND ...\nnote: error: ${(error as Error).message}\n`); return 2; }
  if (args.version) { print(`pinote ${VERSION}`); return 0; }
  if (args.help) { print(help(args)); return 0; }
  try { validateCommand(args); }
  catch (error) { print(`ERROR: ${(error as Error).message}`); return 1; }
  const paths = discoverPaths();
  try { checkCancelled(); configureLogging(paths); return await execute(args, paths); }
  catch (error) {
    if ((error as Error).name === 'AbortError') return process.exitCode === 143 ? 143 : 130;
    const message = error instanceof Error ? error.message : String(error);
    const expected = error instanceof NoteError || typeof (error as NodeJS.ErrnoException).code === 'string' || (error instanceof TypeError && error.message.includes('encoded data'));
    log('error', expected ? message : `Unexpected failure. Run note to check the saved state.\n${error instanceof Error ? error.stack : message}`);
    return 1;
  }
}
