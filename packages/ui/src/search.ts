/** Every word of `query` is somewhere in an item's `text`; names that start with the first word come first, then names holding it. */
export function searchByName<T>(items: T[], query: string, name: (it: T) => string, text: (it: T) => string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  const rank = (it: T) => {
    const n = name(it).toLowerCase();
    return n.startsWith(words[0]!) ? 0 : n.includes(words[0]!) ? 1 : 2;
  };
  return items
    .flatMap((it, i) => {
      const t = text(it).toLowerCase();
      return words.every((w) => t.includes(w)) ? [[it, rank(it), i] as const] : [];
    })
    .sort((a, b) => a[1] - b[1] || a[2] - b[2])
    .map(([it]) => it);
}
