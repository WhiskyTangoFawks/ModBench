import { matchesGlob, relative, sep } from 'node:path';

/** Whether a pattern the user set to exclude leaves out `folder`, or what is inside it, as VS Code's watch reads it. */
export function excludesFolder(patterns: Readonly<Record<string, boolean>>, folder: string, instanceRoot: string): boolean {
  const probes = [folder, `${folder}${sep}a${sep}b`].flatMap((path) => [path, relative(instanceRoot, path)]).map((path) => path.split(sep).join('/'));
  return Object.entries(patterns).some(([pattern, excludes]) => excludes && probes.some((probe) => matchesGlob(probe, pattern)));
}
