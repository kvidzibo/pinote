import { Compartment, EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

// Only explicit editing commands transform source; loading, paste and copy never do.
function sourceBulletIndent(view: EditorView, backspace: boolean): boolean {
  if (view.composing || view.state.readOnly) return false;
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty || state.selection.ranges.length !== 1) return false;
  const line = state.doc.lineAt(range.from);
  const bullet = /^([ \t]*)-([ \t]+|$)/.exec(line.text);
  if (!bullet || (backspace && range.from !== line.from + bullet[0].length)) return false;
  const indent = bullet[1].replace(/\t/g, '  ');
  const removeMarker = backspace && !indent;
  const to = line.from + (removeMarker ? bullet[0].length : bullet[1].length);
  const insert = backspace ? indent.slice(0, -2) : indent + '  ';
  view.dispatch({
    changes: { from: line.from, to, insert },
    selection: EditorSelection.cursor(range.from + insert.length - (to - line.from)),
    scrollIntoView: true, userEvent: backspace ? 'delete.backward' : 'input.indent',
    annotations: isolateHistory.of('full'),
  });
  return true;
}

export function sourceNewline(view: EditorView): boolean {
  if (view.composing) return false;
  if (view.state.readOnly) return true;
  const { state } = view;
  const changes = state.changeByRange(range => {
    const line = state.doc.lineAt(range.from);
    const prefix = state.sliceDoc(line.from, range.from);
    const bullet = /^([ \t]*)-([ \t]+|$)/.exec(prefix);
    if (bullet && !prefix.slice(bullet[0].length).trim() && range.to === line.to) {
      return { changes: { from: line.from, to: range.to, insert: '' }, range: EditorSelection.cursor(line.from) };
    }
    const promote = state.selection.ranges.length === 1 && state.doc.lines === 1 && !!prefix.trim()
      && !/^\s*(?:#{1,6}(?:\s|$)|[>*+-](?:\s|$)|\d+[.)]\s|`{3,}|~{3,})/.test(prefix);
    const heading = /^ {0,3}#{1,6}[ \t]+/.test(prefix);
    const insert = '\n' + (promote || heading ? '- ' : bullet ? bullet[1] + '- ' : '');
    return {
      changes: [...(promote ? [{ from: 0, insert: '# ' }] : []), { from: range.from, to: range.to, insert }],
      range: EditorSelection.cursor(range.from + insert.length + (promote ? 2 : 0)),
    };
  });
  view.dispatch({ ...changes, scrollIntoView: true, userEvent: 'input.type', annotations: isolateHistory.of('full') });
  return true;
}

const style = HighlightStyle.define([
  { tag: tags.heading, class: 'source-heading' },
  { tag: tags.strong, class: 'source-strong' },
  { tag: tags.emphasis, class: 'source-emphasis' },
  { tag: [tags.monospace, tags.processingInstruction], class: 'source-code' },
]);

export class MarkdownEditor {
  readonly view: EditorView;
  private mode = new Compartment();
  private settingText = false;
  constructor(parent: HTMLElement, text: string, label: string, composer: boolean, changed: () => void, submit: () => void) {
    this.view = new EditorView({ parent, state: EditorState.create({ doc: text, extensions: [
      this.mode.of(EditorState.readOnly.of(false)), history(), markdown({ addKeymap: false, pasteURLAsLink: false }), syntaxHighlighting(style),
      EditorView.lineWrapping,
      EditorView.cspNonce.of(document.querySelector<HTMLMetaElement>('meta[name=style-nonce]')?.content ?? ''),
      EditorView.contentAttributes.of({ 'aria-label': label, 'aria-multiline': 'true', spellcheck: 'false', tabindex: '0' }),
      ...(composer ? [placeholder(label)] : []),
      keymap.of([
        { key: composer ? 'Enter' : 'Ctrl-Enter', run: view => { if (view.composing) return false; submit(); return true; } },
        { key: 'Enter', run: sourceNewline }, { key: 'Shift-Enter', run: sourceNewline },
        { key: 'Tab', run: view => sourceBulletIndent(view, false) },
        { key: 'Backspace', run: view => sourceBulletIndent(view, true) },
        ...defaultKeymap, ...historyKeymap,
      ]),
      EditorView.updateListener.of(update => { if (update.docChanged && !this.settingText) changed(); }),
    ] }) });
  }
  get dom(): HTMLElement { return this.view.contentDOM; }
  get value(): string { return this.view.state.doc.toString(); }
  setText(text: string): void {
    // Loading or clearing a saved draft is not user input and must not queue an
    // autosave of the restored snapshot over newer state.
    this.settingText = true;
    try {
      this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text }, annotations: Transaction.addToHistory.of(false) });
    } finally { this.settingText = false; }
  }
  set readOnly(value: boolean) {
    this.view.dispatch({ effects: this.mode.reconfigure(EditorState.readOnly.of(value)) });
    this.dom.setAttribute('aria-readonly', String(value));
  }
  destroy(): void { this.view.destroy(); }
}

export function compactTitle(text: string): string { return (text.split('\n')[0] ?? '').replace(/^ {0,3}#{1,6}[ \t]+/, ''); }
