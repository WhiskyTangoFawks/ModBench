import { present } from '../ports/present';

/** One order of keyed sources against the order before it. */
export interface Reordered<T> {
  readonly was: ReadonlyMap<string, T>;
  readonly now: ReadonlyMap<string, T>;
  readonly rank: ReadonlyMap<string, number>;
  /** Each key whose source changed, that one order holds alone, or that moved among the others. */
  readonly changed: ReadonlySet<string>;
  /** Each key both orders hold that moved among the others. */
  readonly moved: ReadonlySet<string>;
}

// The keys both orders hold outside a longest run they hold in the same order: moving those alone turns `was` into `now`.
function movedKeys(was: readonly string[], now: readonly string[]): string[] {
  const placeWas = new Map(was.map((key, at) => [key, at]));
  const both = now.flatMap((key) => {
    const place = placeWas.get(key);
    return place === undefined ? [] : [{ key, place }];
  });
  // Patience sorting: `ends[length - 1]` is where the run of that length with the lowest last place ends.
  const ends: number[] = [];
  const before = both.map((): number => -1);
  both.forEach(({ place }, at) => {
    let [low, high] = [0, ends.length];
    while (low < high) {
      const middle = (low + high) >> 1;
      if (present(both[present(ends[middle], 'a run')], 'a key').place < place) low = middle + 1;
      else high = middle;
    }
    before[at] = low > 0 ? present(ends[low - 1], 'a run') : -1;
    ends[low] = at;
  });
  const inRun = new Set<number>();
  for (let at = ends.at(-1) ?? -1; at >= 0; at = present(before[at], 'a run')) inRun.add(at);
  return both.flatMap(({ key }, at) => (inRun.has(at) ? [] : [key]));
}

export function reordered<T>(was: readonly T[], now: readonly T[], keyOf: (source: T) => string, same: (a: T, b: T) => boolean): Reordered<T> {
  const [before, after] = [new Map(was.map((source) => [keyOf(source), source])), new Map(now.map((source) => [keyOf(source), source]))];
  const changed = new Set([...before.keys(), ...after.keys()].filter((key) => {
    const [then, current] = [before.get(key), after.get(key)];
    return then === undefined || current === undefined || !same(then, current);
  }));
  const moved = new Set(movedKeys([...before.keys()], [...after.keys()]));
  for (const key of moved) changed.add(key);
  return { was: before, now: after, rank: new Map([...after.keys()].map((key, at) => [key, at])), changed, moved };
}

/** `sources` by their rank now. */
export const inRank = <T>(sources: readonly T[], keyOf: (source: T) => string, { rank }: Pick<Reordered<unknown>, 'rank'>): T[] =>
  [...sources].sort((a, b) => (rank.get(keyOf(a)) ?? 0) - (rank.get(keyOf(b)) ?? 0));

/** Each path a changed source holds now or held before; of a source that changed in its place, each `between` gives. */
export function pathsChanged<T>(
  { was, now, changed, moved }: Reordered<T>, pathsIn: (source: T) => Iterable<string>, between?: (was: T, now: T) => Iterable<string>,
): Set<string> {
  const paths = new Set<string>();
  for (const key of changed) {
    const [then, current] = [was.get(key), now.get(key)];
    const inPlace = between !== undefined && then !== undefined && current !== undefined && !moved.has(key);
    for (const path of inPlace ? between(then, current) : [then, current].flatMap((source) => (source === undefined ? [] : [...pathsIn(source)]))) paths.add(path);
  }
  return paths;
}

/** Each item one list holds and the other does not, by identity: what a read that keeps each item that reads the same
 *  gained or lost. */
export function differing<T>(was: readonly T[], now: readonly T[]): T[] {
  const kept = new Set(was);
  const still = new Set(now);
  return [...was.filter((item) => !still.has(item)), ...now.filter((item) => !kept.has(item))];
}
