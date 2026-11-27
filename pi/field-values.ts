// No Node imports: the desktop's renderer bundles this file too.
/** A handoff field holds Markdown text or a list of single-line items. */
export type FieldValue = string | string[];
export const fieldTypes = ['text', 'list', 'unique-list'] as const;
export type FieldType = typeof fieldTypes[number];

/** A field's type when its definition names none. */
export const defaultFieldType = (name: string): FieldType =>
  name === 'PRs' || name === 'PR' || name === 'Worktrees' ? 'unique-list' : 'text';
export const fieldType = (field: { name: string; type?: FieldType }): FieldType => field.type ?? defaultFieldType(field.name);

/** A value's text form: a list is its items, one per line. */
export const fieldText = (value: FieldValue): string => Array.isArray(value) ? value.join('\n') : value;
export const fieldTexts = (notes: Record<string, FieldValue> = {}): Record<string, string> =>
  Object.fromEntries(Object.entries(notes).map(([name, value]) => [name, fieldText(value)]));
/** A value's items: its nonblank lines, trimmed. */
export function fieldItems(value: FieldValue | undefined, unique = false): string[] {
  const items = (Array.isArray(value) ? value : [value ?? '']).flatMap((entry) => entry.split(/\r?\n/))
    .map((line) => line.trim()).filter(Boolean);
  return unique ? [...new Set(items)] : items;
}
