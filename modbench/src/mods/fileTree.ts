// A file listing as a folder tree, in the Explorer's order.

// The Explorer's default order: case aside, and a run of digits by its value. Names equal but for
// case, which a case-sensitive file system holds, then go by code unit, as the Explorer's do.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export const byName = ([a]: readonly [string, unknown], [b]: readonly [string, unknown]): number =>
  collator.compare(a, b) || byCodeUnit(a, b);

// Each entry directly in a folder by its name, and those below it by the name of the folder that
// holds them.
export function byLevel<T extends { readonly relativePath: string }>(entries: readonly T[], prefix: string) {
  const here = new Map<string, T>();
  const below = new Map<string, T[]>();
  for (const entry of entries) {
    const rest = entry.relativePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      here.set(rest, entry);
      continue;
    }
    const name = rest.slice(0, slash);
    below.set(name, [...below.get(name) ?? [], entry]);
  }
  return { here, below };
}
