import { dirname, sep } from 'node:path';

const compiled = new Map<string, RegExp>();

// VS Code's glob: `**` crosses folders, a single star and `?` stay in one name, `{a,b}` alternates, and a trailing `/**` takes its folder in.
function regExpOf(pattern: string): RegExp {
  const known = compiled.get(pattern);
  if (known) return known;
  let braces = 0;
  const source = pattern.replace(/\/\*\*$|\*\*\/|\*\*|\*|\?|[{},]|[.+^$()|[\]\\]/g, (token) => {
    switch (token) {
      case '/**': return '(?:/.*)?';
      case '**/': return '(?:.*/)?';
      case '**': return '.*';
      case '?': return '[^/]';
      case '{': braces++; return '(?:';
      case '}': if (braces === 0) return '\\}'; braces--; return ')';
      case ',': return braces > 0 ? '|' : ',';
      default: return token.length === 1 && /[.+^$()|[\]\\]/.test(token) ? `\\${token}` : '[^/]*';
    }
  });
  const regExp = new RegExp(`^${source}$`, process.platform === 'win32' ? 'i' : '');
  compiled.set(pattern, regExp);
  return regExp;
}

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
  const excluding = Object.entries(patterns).filter(([, excludes]) => excludes).map(([pattern]) => pattern);
  const matchers = excluding.map((pattern) => ({ pattern, regExp: regExpOf(pattern) }));
  const inRoot = `${instanceRoot}${sep}`;
  const matches =(regExp: RegExp, path: string): boolean => {
    return regExp.test(asGlobPath(path)) || (path.startsWith(inRoot) && regExp.test(asGlobPath(path.slice(inRoot.length))));
  };
  const excludesAny = (path: string): boolean => matchers.some(({ regExp }) => matches(regExp, path));
  const folders = new Map<string, boolean>();
  const excludesFolder = (folder: string): boolean => {
    const known = folders.get(folder);
    if (known !== undefined) return known;
    const parent = dirname(folder);
    const excluded = matchers.length > 0 && (excludesAny(folder) || (parent !== folder && excludesFolder(parent)));
    folders.set(folder, excluded);
    return excluded;
  };
  return {
    excludesFolder,
    topmostExcluded: (listed) => listed.filter((folder) => excludesFolder(folder) && !excludesFolder(dirname(folder))),
    patternsExcludingFiles: (files) => matchers
      .filter(({ regExp }) => files.some((file) => matches(regExp, file) && !excludesFolder(dirname(file))))
      .map(({ pattern }) => pattern),
  };
}
