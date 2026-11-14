/** Display-only title: keep Markdown source intact for editing and previews. */
export function taskTitle(text: string): string {
  return text.split("\n", 1)[0].replace(/^ {0,3}#{1,6}[ \t]+/u, "");
}
