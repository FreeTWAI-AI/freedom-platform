/** Case-insensitive match over the text a reader sees on a skill book. Every space-separated word must appear, in any order or field. */
export function matchesSkillSearch(term: string, values: (string | null | undefined)[]) {
  const words = term.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = values.join(' ').toLocaleLowerCase();
  return words.every(word => haystack.includes(word));
}
