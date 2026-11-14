import { defaultFooterField, parseAgentGuidance, parseFooterConfig, parseHandoffPrompt, parseNewSessionPrompt } from '../footer-config.ts';
import { parseFieldWatchers } from '../field-watchers.ts';
import { clean, editorText, type NativeControl, type NativeView } from './protocol.ts';

export type Screen = 'home' | 'tasks' | 'settings' | 'prompts' | 'footer' | 'fields' | 'field' | 'watchers';
const group = (id: Screen, label: string, description: string): NativeControl => ({ id: `__${id}`, label, description, kind: 'action' });
export const parentScreen = (screen: Screen): Screen | undefined => ({ tasks: 'home', settings: 'home', prompts: 'settings', footer: 'settings', fields: 'settings', field: 'fields', watchers: 'fields' } as const)[screen as Exclude<Screen, 'home'>];
export const serverScreen = (screen: Screen) => screen === 'home' || screen === 'tasks' ? 'tasks' : screen === 'field' ? 'field' : 'settings';

/** Local navigation only. Server controls/revisions remain the authority for every action. */
export function menuView(view: NativeView, screen: Screen): NativeView {
  const take = (...ids: string[]) => ids.flatMap((id) => view.controls.filter((c) => c.id === id));
  let controls: NativeControl[], title: string, body: string;
  switch (screen) {
    case 'home':
      title = 'Pinote'; body = view.body ?? '';
      controls = [...take('preview', 'proposal:preview', 'proposal:accept', 'proposal:dismiss', 'continue'),
        group('tasks', view.state.selectedId ? 'Switch task…' : 'Choose a task…', 'Search tasks by title, description, tag or #ID. Enter starts and selects the chosen task.'),
        ...take('add'), group('settings', 'Settings…', 'Shared prompts, task suggestions and footer display settings.'), ...take('done', 'clear')];
      break;
    case 'tasks':
      title = 'Pinote / Tasks'; body = view.body ?? '';
      controls = view.controls.filter((c) => c.id.startsWith('select:'));
      break;
    case 'settings':
      title = 'Pinote / Settings'; body = 'Shared service settings · affects all connected clients. Task values are unchanged.';
      controls = [group('prompts', 'Prompts and agent guidance…', 'Edit shared task prompts and injected instructions.'),
        ...take('taskOfferPolicy'), group('footer', 'Footer layout…', 'Set title/field widths and the maximum visible handoff fields.'),
        group('fields', 'Footer fields…', 'Edit display definitions, not saved task values.')];
      break;
    case 'prompts':
      title = 'Pinote / Settings / Prompts'; body = 'Shared prompts and instructions · each change requires review and confirmation.';
      controls = take('handoffPrompt', 'newSessionPrompt', 'agentGuidance', 'reset-agent-guidance');
      // The service deliberately omits oversized editors. Keep its explanation visible.
      if (view.body?.includes('editor limit')) body = view.body;
      break;
    case 'footer':
      title = 'Pinote / Settings / Footer layout'; body = 'Shared display settings · widths are terminal columns. Task values are retained.';
      controls = take('titleWidth', 'fieldWidth', 'maxFields');
      break;
    case 'fields':
      title = 'Pinote / Settings / Footer fields'; body = 'Display definitions only. Populated task values appear in the footer.';
      controls = [group('watchers', 'Watchers…', 'Bundled and custom field watchers; explicitly enable trusted code and automatic worker actions.'),
        ...view.controls.filter((c) => c.id.startsWith('field:')), ...take('add-field')];
      break;
    case 'watchers':
      title = 'Pinote / Settings / Fields / Watchers';
      body = 'Shared service watchers · enabling runs trusted code and triggers the owning worker on alerts. New files are disabled.';
      controls = [...view.controls.filter((c) => c.id.startsWith('watcher:') || c.id.startsWith('remove-watcher:')), ...take('add-watcher')];
      break;
    case 'field':
      title = `Pinote / Settings / Fields / ${clean(String(view.state.field ?? ''))}`;
      body = view.body ?? 'Shared display definition. Task values are unchanged.';
      controls = take('label', 'format', 'width', 'link', 'remove-field');
      break;
  }
  return { ...view, title, body, controls };
}

/** Reuse the same domain parsers as the service, before the remote revision-checked save. */
export function inputValue(control: NativeControl, text: string, view: NativeView): NativeControl['value'] {
  editorText(text);
  if (text.length > 20_000) throw new Error('This editor accepts at most 20,000 characters. Edit larger values on the service.');
  if (control.kind === 'number') {
    if (!/^[+-]?\d+$/.test(text.trim())) throw new Error('Enter a whole number.');
    const value = Number(text);
    parseFooterConfig({ footer: { [control.id === 'width' ? 'fieldWidth' : control.id]: value } });
    return value;
  }
  if (!control.multiline && /[\r\n\t]/.test(text)) throw new Error('Enter one line, without tabs.');
  switch (control.id) {
    case 'add':
      if (!text.trim() || [...text].length > 4000) throw new Error('Enter task text, up to 4,000 characters.');
      break;
    case 'handoffPrompt': parseHandoffPrompt(text); break;
    case 'newSessionPrompt': parseNewSessionPrompt(text); break;
    case 'agentGuidance': parseAgentGuidance(text); break;
    case 'add-watcher':
      return parseFieldWatchers({ fieldWatchers: [{ path: text, enabled: false }] })[0].path;
    case 'add-field': {
      const field = parseFooterConfig({ footer: { fields: [defaultFooterField(text)] } }).fields![0];
      const fields = view.controls.filter((c) => c.id.startsWith('field:'));
      if (fields.length >= 64) throw new Error('At most 64 field definitions are allowed.');
      if (fields.some((c) => c.id === `field:${field.name}`)) throw new Error('A field with this name already exists.');
      return field.name;
    }
    case 'label': case 'format':
      parseFooterConfig({ footer: { fields: [{ ...defaultFooterField('Example'), [control.id]: text }] } });
      break;
  }
  return text;
}

/** Quoted lines preserve significant whitespace without turning Unicode into unreadable escapes. */
export function disclosure(value: unknown): string {
  const quote = (s: string) => JSON.stringify(s).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return typeof value === 'string' ? value.split('\n').map(quote).join('\n') : JSON.stringify(value) ?? '(unset)';
}
