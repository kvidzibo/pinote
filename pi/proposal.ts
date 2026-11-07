// Shared by the Pi tools and service so proposal limits cannot drift.
export const proposalTitleOptions = {
  minLength: 1,
  maxLength: 60,
  // Unlike $, the final assertion cannot match before a trailing newline.
  pattern: '^(?!\\s*$)[^\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+(?![\\s\\S])',
  description: 'Short, action-oriented single-line title (1–60 characters); no implementation details.',
};
export const proposalDescriptionOptions = {
  maxLength: 3997,
  description: 'Optional multiline context, URLs, commands, and acceptance criteria. Title + blank line + description must fit 4000 characters.',
};

export function proposalText(title: string, description?: string): string {
  if (typeof title !== 'string' || [...title].length > 60 || !new RegExp(proposalTitleOptions.pattern, 'u').test(title)) {
    throw new Error('title must be a nonblank single line of 1–60 characters without control characters.');
  }
  if (description !== undefined && (typeof description !== 'string' || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(description))) {
    throw new Error('description must be text without control characters (except tabs/newlines).');
  }
  const text = description ? `${title}\n\n${description}` : title;
  if ([...text].length > 4000) throw new Error('Title, blank line, and description must not exceed 4000 characters in total.');
  return text;
}
