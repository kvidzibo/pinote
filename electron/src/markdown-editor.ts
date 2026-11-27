import { Compartment, EditorSelection, EditorState, RangeSetBuilder, StateField, Transaction, type Text } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap, placeholder, type DecorationSet } from '@codemirror/view';
import { IMAGE_REF, imageElement, imageHashes } from './image-refs';
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

// An image reference shows as its picture and behaves as one character: Backspace deletes all of it.
class ImageWidget extends WidgetType {
  constructor(readonly hash: string, readonly alt: string) { super(); }
  eq(other: ImageWidget): boolean { return other.hash === this.hash && other.alt === this.alt; }
  toDOM(view: EditorView): HTMLElement {
    const image = imageElement(`images/${this.hash}`, this.alt || 'image', 'cm-image');
    // Loaded pictures change line heights: keep the cursor in view, as after typing.
    image.querySelector('img')!.addEventListener('load', () => { if (view.hasFocus) view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head) }); else view.requestMeasure(); }, { once: true });
    return image;
  }
}
function imageDecorations(doc: Text): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const match of doc.toString().matchAll(IMAGE_REF)) builder.add(match.index, match.index + match[0].length, Decoration.replace({ widget: new ImageWidget(match[2], match[1]) }));
  return builder.finish();
}
const images = StateField.define<DecorationSet>({
  create: state => imageDecorations(state.doc),
  update: (value, tr) => tr.docChanged ? imageDecorations(tr.state.doc) : value,
  provide: field => [EditorView.decorations.from(field), EditorView.atomicRanges.of(view => view.state.field(field))],
});
/** Inserts an image reference on its own line in place of a range; returns the position after it. */
export function insertImage(view: EditorView, ref: string, { from, to }: { from: number; to: number } = view.state.selection.main): number {
  const before = view.state.sliceDoc(view.state.doc.lineAt(from).from, from).trim() ? '\n' : '';
  const after = view.state.sliceDoc(to, view.state.doc.lineAt(to).to).trim() ? '\n' : '';
  const end = from + before.length + ref.length, main = view.state.selection.main;
  // The cursor follows the image unless it moved elsewhere while the image was stored.
  const follow = main.from === from && main.to === to;
  view.dispatch({ changes: { from, to, insert: before + ref + after }, ...(follow ? { selection: { anchor: end } } : {}), scrollIntoView: follow, userEvent: 'input.paste' });
  return end;
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
  // Images this editor has shown since the last release; undo can still bring them back.
  private images = new Set<string>();
  // Pastes still being stored, and the ranges they will replace (mapped through later edits).
  private pasting = new Set<Promise<void>>();
  private targets = new Set<{ from: number; to: number }>();
  constructor(parent: HTMLElement, text: string, label: string, composer: boolean, changed: () => void, submit: () => void,
    storeImage?: (file: File) => Promise<string | null>) {
    for (const hash of imageHashes(text)) this.images.add(hash);
    // Pasted or dropped images (without text) are stored, then referenced at the selection.
    const paste = (view: EditorView, data: DataTransfer | null, event: Event) => {
      const files = Array.from(data?.files ?? []).filter(file => file.type.startsWith('image/'));
      if (!storeImage || !files.length || data!.getData('text/plain').trim()) return false;
      event.preventDefault();
      if (view.state.readOnly) return true;
      const target = { from: view.state.selection.main.from, to: view.state.selection.main.to };
      this.targets.add(target);
      // Every file of the paste is accepted now; insertion keeps their order.
      const stored = files.map(file => storeImage(file));
      const work: Promise<void> = (async () => {
        for (const pending of stored) {
          const ref = await pending;
          if (ref && !this.destroyed && !view.state.readOnly) target.from = target.to = insertImage(view, ref, target);
        }
      })().finally(() => { this.targets.delete(target); this.pasting.delete(work); });
      this.pasting.add(work);
      return true;
    };
    this.view = new EditorView({ parent, state: EditorState.create({ doc: text, extensions: [
      this.mode.of(EditorState.readOnly.of(false)), history(), markdown({ addKeymap: false, pasteURLAsLink: false }), syntaxHighlighting(style), images,
      EditorView.domEventHandlers({
        paste: (event, view) => paste(view, event.clipboardData, event),
        drop: (event, view) => {
          const at = view.posAtCoords(event);
          if (at !== null && storeImage && Array.from(event.dataTransfer?.files ?? []).some(file => file.type.startsWith('image/'))) view.dispatch({ selection: { anchor: at } });
          return paste(view, event.dataTransfer, event);
        },
      }),
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
      EditorView.updateListener.of(update => {
        if (!update.docChanged) return;
        // Text typed over a pending paste's selection stays; the image then goes after it.
        for (const target of this.targets) {
          let replaced = false;
          update.changes.iterChangedRanges((from, to) => { if (from < target.to && to > target.from) replaced = true; });
          target.from = update.changes.mapPos(replaced ? target.to : target.from, 1);
          target.to = replaced ? target.from : Math.max(target.from, update.changes.mapPos(target.to, -1));
        }
        for (const hash of imageHashes(update.state.doc.toString())) this.images.add(hash);
        if (!this.settingText) changed();
      }),
    ] }) });
  }
  get dom(): HTMLElement { return this.view.contentDOM; }
  get value(): string { return this.view.state.doc.toString(); }
  /** Resolves once pasted images have been stored and inserted (or failed). */
  async imagesSettled(): Promise<void> { while (this.pasting.size) await Promise.allSettled([...this.pasting]); }
  /** Images shown since the last release, including ones deleted from the text. */
  get imageHashes(): string[] { return [...this.images]; }
  /** Forgets deleted images so they can be pruned; true if any were deleted. */
  releaseImages(): boolean {
    const current = new Set(imageHashes(this.value)), released = [...this.images].some(hash => !current.has(hash));
    this.images = current; return released;
  }
  private destroyed = false;
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
  destroy(): void { this.destroyed = true; this.view.destroy(); }
}

export function compactTitle(text: string): string { return (text.split('\n')[0] ?? '').replace(/^ {0,3}#{1,6}[ \t]+/, '').replace(IMAGE_REF, '[image]'); }
