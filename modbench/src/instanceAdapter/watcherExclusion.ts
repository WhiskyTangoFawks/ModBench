import { dirname, sep } from 'node:path';
import picomatch from 'picomatch';

const compiled = new Map<string, (path: string) => boolean>();

// The file system decides the case, as it does for VS Code's watcher.
const matcherOf = (pattern: string): ((path: string) => boolean) => {
  const known = compiled.get(pattern);
  if (known) return known;
  const matcher = picomatch(pattern, { dot: true, nocase: process.platform === 'win32' });
  compiled.set(pattern, matcher);
  return matcher;
};

const asGlobPath = (path: string): string => (sep === '/' ? path : path.split(sep).join('/'));

export interface Exclusion {
  /** Whether `folder`, or a folder above it, is one the user excluded. */
  excludesFolder(folder: string): boolean;
  /** Each of `folders` that is excluded while the folder holding it is not. */
  topmostExcluded(folders: readonly string[]): string[];
  /** Each pattern that excludes a file of `files` whose folder is not itself excluded. */
  patternsExcludingFiles(files: readonly string[]): string[];
}

/** The folders and files the user's true `files.watcherExclude` patterns leave out, each pattern read as an absolute path
 *  and as a path relative to the instance root. */
export function exclusionOf(patterns: Readonly<Record<string, boolean>>, instanceRoot: string): Exclusion {
  const matchers = Object.entries(patterns).filter(([, excludes]) => excludes).map(([pattern]) => ({ pattern, matches: matcherOf(pattern) }));
  const inRoot = `${instanceRoot}${sep}`;
  const excludedBy = (matches: (path: string) => boolean, path: string): boolean =>
    matches(asGlobPath(path)) || (path.startsWith(inRoot) && matches(asGlobPath(path.slice(inRoot.length))));
  const folders = new Map<string, boolean>();
  const excludesFolder = (folder: string): boolean => {
    const known = folders.get(folder);
    if (known !== undefined) return known;
    const parent = dirname(folder);
    const excluded = matchers.some(({ matches }) => excludedBy(matches, folder)) || (parent !== folder && excludesFolder(parent));
    folders.set(folder, excluded);
    return excluded;
  };
  return {
    excludesFolder,
    topmostExcluded: (listed) => listed.filter((folder) => excludesFolder(folder) && !excludesFolder(dirname(folder))),
    patternsExcludingFiles: (files) => matchers
      .filter(({ matches }) => files.some((file) => excludedBy(matches, file) && !excludesFolder(dirname(file))))
      .map(({ pattern }) => pattern),
  };
}
