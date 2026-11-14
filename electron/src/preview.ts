import type { PreviewData } from './protocol';
import { fillPreview } from './preview-content';

const api = window.pinotePreview;
const panel = document.querySelector<HTMLElement>('.panel')!;
const body = document.getElementById('body')!;
let current: PreviewData | undefined;
function report(error: unknown): void {
  const message = document.getElementById('error')!;
  message.textContent = error instanceof Error ? error.message : String(error); message.hidden = false;
}
function draw(data: PreviewData): void {
  if (JSON.stringify(current) === JSON.stringify(data)) return;
  const scroll = body.scrollTop;
  current = data;
  document.getElementById('title')!.textContent = `Task ${data.task.id}`;
  panel.setAttribute('aria-label', `Task ${data.task.id}`);
  document.getElementById('close')!.setAttribute('aria-label', `Close Task ${data.task.id}`);
  fillPreview(body, data.task, { markdown: data.markdown, openLink: url => { void api.openLink(url).catch(report); } });
  body.scrollTop = scroll;
}
for (const action of ['copy', 'edit', 'close'] as const) document.getElementById(action)!.addEventListener('click', () => { void api.action(action).catch(report); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); void api.action('close').catch(report); }
  if (event.key !== 'Tab') return;
  const focusable = Array.from(panel.querySelectorAll<HTMLElement>('button, a[href]'));
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
});
api.onUpdate(draw);
async function init(): Promise<void> {
  const data = await api.load();
  if (!current) draw(data);
  await document.fonts.ready;
  await api.ready(panel.getBoundingClientRect().height + 2);
  panel.focus();
  if (data.unread) body.querySelector('.agent')?.scrollIntoView({ block: 'start' });
}
void init().catch(report);
