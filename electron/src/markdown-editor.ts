import { Compartment, EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

// Only explicit newline commands transform source; loading, paste and copy never do.
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
  constructor(parent: HTMLElement, text: string, label: string, composer: boolean, changed: () => void, submit: () => void) {
    this.view = new EditorView({ parent, state: EditorState.create({ doc: text, extensions: [
      this.mode.of(EditorState.readOnly.of(false)), history(), markdown(), syntaxHighlighting(style),
      EditorView.lineWrapping,
      EditorView.cspNonce.of(document.querySelector<HTMLMetaElement>('meta[name=style-nonce]')?.content ?? ''),
      EditorView.contentAttributes.of({ 'aria-label': label, 'aria-multiline': 'true', spellcheck: 'false' }),
      ...(composer ? [placeholder(label)] : []),
      keymap.of([
        { key: composer ? 'Enter' : 'Ctrl-Enter', run: view => { if (view.composing) return false; submit(); return true; } },
        { key: 'Enter', run: sourceNewline }, { key: 'Shift-Enter', run: sourceNewline },
        ...defaultKeymap, ...historyKeymap,
      ]),
      EditorView.updateListener.of(update => { if (update.docChanged) changed(); }),
    ] }) });
  }
  get dom(): HTMLElement { return this.view.contentDOM; }
  get value(): string { return this.view.state.doc.toString(); }
  setText(text: string): void { this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text }, annotations: Transaction.addToHistory.of(false) }); }
  set readOnly(value: boolean) {
    this.view.dispatch({ effects: this.mode.reconfigure(EditorState.readOnly.of(value)) });
    this.dom.setAttribute('aria-readonly', String(value));
  }
  destroy(): void { this.view.destroy(); }
}

export function compactTitle(text: string): string { return (text.split('\n')[0] ?? '').replace(/^ {0,3}#{1,6}[ \t]+/, ''); }
