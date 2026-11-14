import type { Task } from './protocol';
import MarkdownIt from 'markdown-it';
type Token = { type: string; tag: string; nesting: number; content: string; children?: Token[]; attrs?: [string, string][] };
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
type PreviewOptions = { markdown: boolean; openLink: (url: string) => void };
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

// Markdown tokens become only known DOM elements. No HTML, style, or event attributes are copied.
const allowed = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'em', 'strong', 's', 'blockquote', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
function safeLink(value: string): boolean { try { return ['http:', 'https:', 'mailto:'].includes(new URL(value).protocol); } catch { return false; } }
function markdownDOM(text: string, parent: HTMLElement, options: PreviewOptions, firstLineHeading = true): void {
  if (!options.markdown) { parent.append(el('pre', text, 'literal')); return; }
  const stack: HTMLElement[] = [parent];
  function tokens(items: Token[]): void {
    for (const token of items) {
      const top = () => stack[stack.length - 1];
      if (token.type === 'inline') { tokens(token.children ?? []); continue; }
      if (token.type === 'text' || token.type === 'html_inline' || token.type === 'html_block') { top().append(document.createTextNode(token.content)); continue; }
      if (token.type === 'softbreak' || token.type === 'hardbreak') { top().append(el('br')); continue; }
      if (token.type === 'image') { top().append(document.createTextNode(token.content || '(image)')); continue; }
      if (token.type === 'code_inline') { top().append(el('code', token.content)); continue; }
      if (token.type === 'fence' || token.type === 'code_block') { const pre = el('pre'); pre.append(el('code', token.content)); top().append(pre); continue; }
      if (token.type === 'hr') { top().append(el('hr')); continue; }
      if (token.type === 'link_open') {
        const url = token.attrs?.find(a => a[0] === 'href')?.[1] ?? '';
        const a = el('a');
        if (safeLink(url)) { a.href = url; a.title = url; a.addEventListener('click', e => { e.preventDefault(); options.openLink(url); }); }
        top().append(a); stack.push(a); continue;
      }
      if (token.type === 'link_close') { if (stack.length > 1) stack.pop(); continue; }
      if (allowed.has(token.tag)) {
        if (token.nesting === 1) { const node = document.createElement(token.tag); top().append(node); stack.push(node); }
        else if (token.nesting === -1 && stack.length > 1) stack.pop();
      } else if (token.content) top().append(document.createTextNode(token.content));
    }
  }
  const parsed = markdown.parse(text, {}) as Token[];
  // A normal literal first line is a heading in the preview, without changing saved text.
  const first = text.split('\n')[0] ?? '';
  if (firstLineHeading && parsed[0]?.type === 'paragraph_open' && !/^\s*(?:[#>*+-]|\d+[.)])\s/.test(first)) {
    const split = text.indexOf('\n'), heading = el('h1');
    parent.append(heading); stack.push(heading);
    const line = markdown.parse(first, {}) as Token[];
    tokens(line.find(t => t.type === 'inline')?.children ?? []); stack.pop();
    if (split >= 0) tokens(markdown.parse(text.slice(split + 1), {}) as Token[]);
  } else tokens(parsed);
}
export function fillPreview(parent: HTMLElement, task: Task, options: PreviewOptions): void {
  parent.replaceChildren(); markdownDOM(task.text, parent, options);
  if (Object.keys(task.agent_notes).length || task.agent_event_id > 0) {
    const agent = el('section', undefined, 'agent'); agent.append(el('h3', 'Agent'));
    if (!Object.keys(task.agent_notes).length) agent.append(el('p', 'Agent fields were removed.'));
    for (const [key, value] of Object.entries(task.agent_notes)) { agent.append(el('h4', key)); const body = el('div'); markdownDOM(value, body, options, false); agent.append(body); }
    parent.append(agent);
  }
  if (task.pi_sessions.length) {
    const sessions = el('section', undefined, 'sessions');
    sessions.append(el('h3', 'Pi sessions'));
    for (const session of task.pi_sessions) sessions.append(el('pre', session, 'literal'));
    parent.append(sessions);
  }
}
