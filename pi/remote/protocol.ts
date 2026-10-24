// Vendored native-ui v1 wire primitives from mcp-session-gateway; independently hosted here.
import { z } from 'zod';

// Private, versioned terminal UI protocol, not the HTML MCP Apps extension.
export const UI_MIME = 'application/vnd.mcp-native-ui+json';
export const UI_CONTEXT = 'native-ui/context';
export const UI_STATE = 'native-ui/state';
export const UI_FEATURES = 'native-ui/features';
export const UI_STALE_ACTION = -33003;
export const StaleActionDataSchema = z.object({ 'native-ui/action': z.object({ status: z.literal('not-applied'), reason: z.literal('stale-view') }) });
const text = z.string().max(20_000);
const scalar = z.union([text, z.number().finite(), z.boolean(), z.null()]);
export const StateSchema = z.record(z.string(), z.unknown()).refine((state) => JSON.stringify(state).length <= 8192, 'UI state exceeds 8 KiB');
const control = z.object({
  id: z.string().min(1).max(256), label: text, icon: z.string().max(8).optional(), description: text.optional(),
  kind: z.enum(['action', 'text', 'number', 'toggle', 'select']),
  value: scalar.optional(), multiline: z.boolean().optional(),
  options: z.array(z.object({ label: text, value: scalar })).max(256).optional(),
  confirm: text.optional(), revision: z.string().min(1).max(256).optional(),
}).strict();
export const ViewSchema = z.object({
  version: z.literal(1), title: text, revision: z.string().min(1).max(256),
  state: StateSchema, body: text.optional(), retainOnNew: z.boolean().optional(),
  controls: z.array(control).max(256),
  footer: z.array(z.object({ text, openApp: z.literal(true).optional(), url: z.string().max(2048).optional(), action: z.string().min(1).max(256).optional(), secondaryAction: z.string().min(1).max(256).optional(), doubleAction: z.string().min(1).max(256).optional(), style: z.object({ italic: z.boolean().optional(), color: z.enum(['accent', 'muted', 'text']).optional() }).strict().optional(), width: z.number().int().min(3).max(1000).optional() }).strict()).max(128).optional(),
}).strict().superRefine((view, ctx) => {
  if (new Set(view.controls.map((c) => c.id)).size !== view.controls.length) ctx.addIssue({ code: 'custom', message: 'Duplicate control IDs' });
  for (const item of view.footer ?? []) {
    if (item.openApp && (item.url !== undefined || item.action || item.secondaryAction || item.doubleAction)) {
      ctx.addIssue({ code: 'custom', message: 'App launchers cannot also contain URLs or server actions' });
    }
    if (item.secondaryAction && (!item.action || !view.controls.some((c) => c.id === item.secondaryAction && c.kind === 'action'))) {
      ctx.addIssue({ code: 'custom', message: 'Secondary footer actions require a primary action and an action control' });
    }
    if (item.doubleAction && (item.url !== undefined || !view.controls.some((c) => c.id === item.doubleAction && c.kind === 'action'))) {
      ctx.addIssue({ code: 'custom', message: 'Double footer actions must reference an action control and cannot have a URL' });
    }
    if (item.action && (item.url !== undefined || !view.controls.some((c) => c.id === item.action && c.kind === 'action'))) {
      ctx.addIssue({ code: 'custom', message: 'Footer actions must reference an action control and cannot have a URL' });
    }
  }
});
export const ActionResultSchema = z.object({ view: ViewSchema, draft: text.optional(), preview: text.optional() });
export const ChangedSchema = z.object({ method: z.literal('notifications/native-ui/changed'), params: z.object({ uri: z.string().max(4096) }) });
export type NativeView = z.infer<typeof ViewSchema>;
export type NativeControl = z.infer<typeof control>;

export function clean(text: string): string {
  return cleanUnbounded(text).slice(0, 20_000);
}

/** Preserve long generated preview lines while still stripping terminal controls. */
export function cleanUnbounded(text: string): string {
  return text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
}
/** Make significant whitespace and controls explicit in operator disclosures. */
export const literal = (value: unknown) => (JSON.stringify(value) ?? '(unset)')
  .replace(/[^\x21-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

// Editors render their contents literally; do not silently alter editable data.
export function editorText(text: string): string {
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(text)) throw new Error('Unsupported terminal controls in editor text');
  return text;
}
export function footerText(view: NativeView, clip: (text: string, width: number) => string = (text) => text, styleText: (text: string, style: NonNullable<NonNullable<NativeView['footer']>[number]['style']>) => string = (text) => text): string {
  return (view.footer ?? []).map(({ text, url, style, width }) => {
    const clipped = clip(clean(text).replace(/\n/g, ' '), width ?? 60);
    const label = style ? styleText(clipped, style) : clipped;
    if (!url || /[\s\u0000-\u001f\u007f-\u009f]/u.test(url)) return label;
    try {
      const target = new URL(url);
      if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) return label;
      return `\x1b]8;;${target.href}\x1b\\${label}\x1b]8;;\x1b\\`;
    } catch { return label; }
  }).join('');
}
