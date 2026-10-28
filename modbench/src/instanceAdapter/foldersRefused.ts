import { isBelow, realPathOf } from './gameFolder/pathWithin';

export interface FolderRefusal { readonly item: string; readonly reason: string }

/** The manifests among `asked` whose folder restore refuses (modlist-repository.md, Restore from manifest, stories 13 and
 *  14), compared with every manifest in `folders`: outside the instance folder, or built by another manifest too. Each
 *  folder resolves once. */
export async function foldersRefused(
  instanceRoot: string, folders: ReadonlyMap<string, string>, asked: readonly string[], resolve: (path: string) => Promise<string> = realPathOf,
): Promise<FolderRefusal[]> {
  const [root, ...paths] = await Promise.all([instanceRoot, ...folders.values()].map(resolve));
  const realOf = new Map([...folders.keys()].map((name, at) => [name, paths[at] ?? '']));
  const buildersOf = new Map<string, string[]>();
  for (const [name, path] of realOf) buildersOf.set(path, [...buildersOf.get(path) ?? [], name]);
  return asked.flatMap((item) => {
    const real = realOf.get(item);
    if (real === undefined) return [];
    const why = [
      ...isBelow(root ?? '', real) ? [] : [`its folder '${folders.get(item)}' is outside the instance folder`],
      ...(buildersOf.get(real) ?? []).filter((other) => other !== item).map((other) => `its folder is also built by '${other}'`),
    ];
    return why.length === 0 ? [] : [{ item, reason: `was skipped: ${why.join('; ')}.` }];
  });
}
