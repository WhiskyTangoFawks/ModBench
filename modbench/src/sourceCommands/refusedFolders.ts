import { isAbsolute, relative, resolve, sep } from 'node:path';

const within = (inner: string, outer: string): boolean => {
  const path = relative(outer, inner);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

/** Modlist-repository.md, Restore from manifest, stories 13 and 14. Folders compare without case, as a mod manager's names do. */
export function refusedFolders(instanceRoot: string, folderOf: ReadonlyMap<string, string>): Map<string, string> {
  const folders = [...folderOf].map(([name, folder]) => ({ name, folder, compared: resolve(folder).toLowerCase() }));
  const root = resolve(instanceRoot).toLowerCase();
  const refused = new Map<string, string>();
  for (const { name, folder, compared } of folders) {
    const overlaps = folders.filter((other) => other.name !== name).flatMap((other) => {
      if (relative(compared, other.compared) === '') return [`its folder is also built by '${other.name}'`];
      if (within(compared, other.compared)) return [`its folder is inside the folder of '${other.name}'`];
      return within(other.compared, compared) ? [`its folder holds the folder of '${other.name}'`] : [];
    });
    const outside = within(compared, root) ? [] : [`its folder '${folder}' is outside the instance folder`];
    const why = [...outside, ...overlaps];
    if (why.length > 0) refused.set(name, why.join('; '));
  }
  return refused;
}
