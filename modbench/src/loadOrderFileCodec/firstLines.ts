/** A later line that repeats a key is not read, so the first line holds: the reference tool does so
 *  for mod order (profile.cpp). `repeats` are the lines left out. */
export function firstLines<T>(lines: readonly T[], keyOf: (line: T) => string): { kept: T[]; repeats: T[] } {
  const read = new Set<string>();
  const kept: T[] = [];
  const repeats: T[] = [];
  for (const line of lines) {
    const key = keyOf(line);
    (read.has(key) ? repeats : kept).push(line);
    read.add(key);
  }
  return { kept, repeats };
}
