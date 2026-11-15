import { dirname, matchesGlob, relative, sep } from 'node:path';

const asGlobPath = (path: string): string => path.split(sep).join('/');

/** Whether a pattern the user set to exclude leaves out `folder`: the folder or a folder above it, a pattern ending in `/**` taking its folder in, as an absolute path or
 *  relative to the instance root. A pattern that names files, as `**\/*.dds` does, leaves out no folder. */
export function excludesFolder(patterns: Readonly<Record<string, boolean>>, folder: string, instanceRoot: string): boolean {
  const excluding = Object.entries(patterns).filter(([, excludes]) => excludes).flatMap(([pattern]) => [pattern, pattern.replace(/\/\*\*$/, '')]);
  for (let path = folder; ; path = dirname(path)) {
    const relativePath = relative(instanceRoot, path);
    const inside = relativePath !== '' && !relativePath.startsWith('..');
    if (excluding.some((pattern) => matchesGlob(asGlobPath(path), pattern) || (inside && matchesGlob(asGlobPath(relativePath), pattern)))) return true;
    if (!inside || dirname(path) === path) return false;
  }
}
