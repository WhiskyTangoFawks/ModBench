// formats/manifest.md: a manifest's path never carries the mod manager's mark for an excluded file.

const unmarked = (segment: string, mark: string): string => (segment.endsWith(mark) ? segment.slice(0, -mark.length) : segment);

/** `pathInFolder` as the file's own path, with each path at or above it that `mark` excludes. */
export function ownPathOf(pathInFolder: string, mark: string): { readonly path: string; readonly excluded: readonly string[] } {
  const segments = pathInFolder.split('/');
  const own = segments.map((segment) => unmarked(segment, mark));
  return { path: own.join('/'), excluded: segments.flatMap((segment, at) => (segment.endsWith(mark) ? [own.slice(0, at + 1).join('/')] : [])) };
}

/** The path a folder holds the file at `path` at, its first segment `exclude` names marked. */
export function pathInFolderOf(path: string, exclude: readonly string[], mark: string): string {
  const excluded = new Set(exclude.map((one) => one.toLowerCase()));
  const segments = path.split('/');
  const depth = segments.findIndex((_, at) => excluded.has(segments.slice(0, at + 1).join('/').toLowerCase()));
  return depth < 0 ? path : segments.map((segment, at) => (at === depth ? `${segment}${mark}` : segment)).join('/');
}
