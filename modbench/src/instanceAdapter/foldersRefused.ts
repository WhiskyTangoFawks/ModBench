import { sep } from 'node:path';
import { isBelow, realPathOf } from './gameFolder/pathWithin';

export interface FolderRefusal { readonly item: string; readonly reason: string }

interface Resolved { readonly path: string; readonly segments: readonly string[]; readonly names: string[] }

const bySegments = (a: Resolved, b: Resolved): number => {
  const common = Math.min(a.segments.length, b.segments.length);
  for (let at = 0; at < common; at += 1) {
    const [left = '', right = ''] = [a.segments[at], b.segments[at]];
    if (left !== right) return left < right ? -1 : 1;
  }
  return a.segments.length - b.segments.length;
};

/** The manifests among `asked` whose folder restore refuses (modlist-repository.md, Restore from manifest, stories 13 and
 *  14), compared with every manifest in `folders`. Each folder resolves once, and sorting puts a folder before those inside it. */
export async function foldersRefused(
  instanceRoot: string, folders: ReadonlyMap<string, string>, asked: readonly string[], resolve: (path: string) => Promise<string> = realPathOf,
): Promise<FolderRefusal[]> {
  const [root, ...paths] = await Promise.all([instanceRoot, ...folders.values()].map(resolve));
  const realOf = new Map([...folders.keys()].map((name, at) => [name, paths[at] ?? '']));
  const found = new Map<string, Resolved>();
  for (const [name, path] of realOf) {
    const held = found.get(path) ?? { path, segments: path.split(sep), names: [] };
    held.names.push(name);
    found.set(path, held);
  }
  const shared = new Map<string, string[]>();
  const inside = new Map<string, string[]>();
  const holds = new Map<string, string[]>();
  const add = (reasons: Map<string, string[]>, name: string, other: string): void => { reasons.set(name, [...reasons.get(name) ?? [], other]); };
  const open: Resolved[] = [];
  for (const group of [...found.values()].sort(bySegments)) {
    for (const name of group.names) group.names.filter((other) => other !== name).forEach((other) => { add(shared, name, other); });
    while (open.length > 0 && !isBelow(open.at(-1)?.path ?? '', group.path)) open.pop();
    for (const ancestor of open) {
      for (const name of group.names) add(inside, name, ancestor.names.join("', '"));
      for (const name of ancestor.names) add(holds, name, group.names.join("', '"));
    }
    open.push(group);
  }
  return asked.flatMap((item) => {
    const real = realOf.get(item);
    if (real === undefined) return [];
    const why = [
      ...isBelow(root ?? '', real) ? [] : [`its folder '${folders.get(item)}' is outside the instance folder`],
      ...(shared.get(item) ?? []).map((other) => `its folder is also built by '${other}'`),
      ...(inside.get(item) ?? []).map((other) => `its folder is inside the folder of '${other}'`),
      ...(holds.get(item) ?? []).map((other) => `its folder holds the folder of '${other}'`),
    ];
    return why.length === 0 ? [] : [{ item, reason: `was skipped: ${why.join('; ')}.` }];
  });
}
