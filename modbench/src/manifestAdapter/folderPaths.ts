// mods.md, A source mod, story 2: a source mod's exclusions are the modlist's, held in its folder under the mod manager's
// exclusion mark, and a line names the path the folder holds its file at.

import type { Manifest, ManifestFile, PackageEntry } from './manifest';
import { packageOf } from './packageOf';

function atFolderPath(path: string, exclude: readonly string[], mark: string): string {
  const excluded = new Set(exclude.map((one) => one.toLowerCase()));
  const segments = path.split('/');
  for (let depth = 1; depth <= segments.length; depth++) {
    if (!excluded.has(segments.slice(0, depth).join('/').toLowerCase())) continue;
    return [...segments.slice(0, depth - 1), `${segments[depth - 1] ?? ''}${mark}`, ...segments.slice(depth)].join('/');
  }
  return path;
}

const unmarked = (path: string, mark: string): string =>
  path.split('/').map((segment) => (segment.endsWith(mark) ? segment.slice(0, -mark.length) : segment)).join('/');

const entryAt = (path: string, packagePath: string): PackageEntry =>
  (path.toLowerCase() === packagePath.toLowerCase() ? { kind: 'held' } : { kind: 'heldAt', path: packagePath });

/** `line` at the path the folder holds its file at under `manifest`'s exclusions: a taken file's line keeps its path in its
 *  package, and a built file's moves. A line no package fixes stays as written. */
export function lineAtFolderPath(manifest: Manifest, line: ManifestFile, mark: string): ManifestFile {
  const { entry } = line;
  if (entry.kind !== 'held' && entry.kind !== 'heldAt') return line;
  const at = atFolderPath(unmarked(line.path, mark), manifest.exclude, mark);
  if (at === line.path) return line;
  const pkg = packageOf(manifest, line);
  if (pkg === undefined) return line;
  const inPackage = entry.kind === 'heldAt' ? entry.path : line.path;
  const moved = pkg.kind === 'sourceRepository' ? { kind: 'held' as const } : entryAt(at, inPackage);
  return { path: at, entry: moved, ...(line.package === undefined ? {} : { package: line.package }) };
}

// Each path above and at `path` that a segment under the mark excludes, by its path without the mark.
function excludedBy(path: string, mark: string): string[] {
  const segments = path.split('/');
  return segments.flatMap((segment, at) => (segment.endsWith(mark) ? [unmarked(segments.slice(0, at + 1).join('/'), mark)] : []));
}

/** The paths a source mod's build excludes: each `held` holds under `mark`, and each `manifest` records under it whose
 *  file `held` does not hold included. `held` is the folder's files, none to make the folder what `manifest` says. */
export function exclusionsOf(manifest: Manifest | undefined, held: readonly string[], mark: string): string[] {
  const included = new Set(held.map((path) => path.toLowerCase()));
  const recorded = (manifest?.files ?? []).map(({ path }) => path).filter((path) => !included.has(unmarked(path, mark).toLowerCase()));
  const byFolded = new Map([...recorded, ...held].flatMap((path) => excludedBy(path, mark)).map((path) => [path.toLowerCase(), path]));
  return [...byFolded.values()].sort();
}
