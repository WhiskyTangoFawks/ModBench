// mods.md, A row, File and folder: a mod's or Overwrite's files, as a folder tree.

import * as vscode from 'vscode';
import type { ConflictEntry } from '../instanceLoader/fileConflictIndex';
import type { FileOrigin, OriginFile, OriginFolder } from '../instanceLoader/instance';
import type { ModlistNode } from './ModListProvider';

// Not `file:`: VS Code badges and tints a row whose resourceUri carries a diagnostic or another
// provider's file decoration, and a file row draws neither. The file icon theme reads the name
// from the URI's last segment.
const FILE_ROW_SCHEME = 'modbench-mod-file';

// The Explorer's default order: case aside, and a run of digits by its value. Names equal but for
// case, which a case-sensitive file system holds, then go by code unit, as the Explorer's do.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byName = ([a]: readonly [string, unknown], [b]: readonly [string, unknown]): number =>
  collator.compare(a, b) || byCodeUnit(a, b);

export const sameOrigin = (a: FileOrigin, b: FileOrigin): boolean =>
  a.kind === 'mod' ? b.kind === 'mod' && a.name === b.name : a.kind === b.kind;

/** The winning copy when `own` loses, and the copies `own` wins over, in the index's order, when
 *  it wins. None unless another enabled copy provides the path. */
export function goToModCandidates(entry: ConflictEntry | undefined, own: FileOrigin): FileOrigin[] {
  const providers = entry?.providers ?? [];
  const at = providers.findIndex((provider) => sameOrigin(provider, own));
  if (at === -1) return [];
  return at === 0 ? providers.slice(1) : providers.slice(0, 1);
}

export type ChildrenShown = 'all' | 'matching';

export const expanderOver = (children: readonly unknown[], shown: ChildrenShown = 'all'): vscode.TreeItemCollapsibleState => {
  if (children.length === 0) return vscode.TreeItemCollapsibleState.None;
  return shown === 'matching' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
};

type NameMatch = (name: string) => boolean;

export const shownUnder = (parent: ChildrenShown, matches: NameMatch, name: string): ChildrenShown =>
  (parent === 'matching' && !matches(name) ? 'matching' : 'all');

const pathNamed = (relativePath: string, matches: NameMatch): boolean => relativePath.split('/').some(matches);

export function anyNamed(files: readonly OriginFile[], folders: readonly OriginFolder[], matches: NameMatch): boolean {
  return files.some((file) => pathNamed(file.relativePath, matches)) || folders.some((folder) => pathNamed(folder.relativePath, matches));
}

export function narrowToMatches(
  files: readonly OriginFile[], folders: readonly OriginFolder[], matches: NameMatch,
): { files: OriginFile[]; folders: OriginFolder[] } {
  const foundFiles = files.filter((file) => pathNamed(file.relativePath, matches));
  const foundFolders = folders.filter((folder) => pathNamed(folder.relativePath, matches));
  const above = new Set<string>();
  for (const { relativePath } of [...foundFiles, ...foundFolders]) {
    const segments = relativePath.split('/');
    for (let depth = 1; depth < segments.length; depth++) above.add(segments.slice(0, depth).join('/'));
  }
  return { files: foundFiles, folders: folders.filter((folder) => foundFolders.includes(folder) || above.has(folder.relativePath)) };
}

/** The URI of a file's or folder's row: its origin, and the path in it. A mod's name holds no
 *  slash, so no two rows share one. */
export function fileRowUri(origin: FileOrigin, relativePath: string): vscode.Uri {
  const originPart = origin.kind === 'mod' ? `mod/${origin.name}` : origin.kind;
  return vscode.Uri.from({ scheme: FILE_ROW_SCHEME, path: `/${originPart}/${relativePath}` });
}

function fileRow(row: vscode.TreeItem, parent: ModlistNode, origin: FileOrigin, name: string, relativePath: string): void {
  row.id = `${parent.id}/${name}`;
  row.resourceUri = fileRowUri(origin, relativePath);
  row.tooltip = relativePath;
}

/** A folder in a mod or Overwrite, and the files and folders under it. */
export class FolderNode extends vscode.TreeItem {
  readonly kind = 'folder' as const;
  constructor(
    public readonly parent: ModlistNode,
    public readonly origin: FileOrigin,
    public readonly folder: OriginFolder,
    public readonly files: readonly OriginFile[],
    public readonly folders: readonly OriginFolder[],
    name: string,
    public readonly shown: ChildrenShown = 'all',
  ) {
    super(name, expanderOver([...files, ...folders], shown));
    fileRow(this, parent, origin, name, folder.relativePath);
    this.contextValue = 'folder';
  }
}

export class FileNode extends vscode.TreeItem {
  readonly kind = 'file' as const;
  constructor(
    public readonly parent: ModlistNode,
    public readonly origin: FileOrigin,
    public readonly file: OriginFile,
    name: string,
    public readonly inConflict = false,
  ) {
    super(name, vscode.TreeItemCollapsibleState.None);
    fileRow(this, parent, origin, name, file.relativePath);
    this.contextValue = inConflict ? 'file conflict' : 'file';
    this.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(file.path), { preview: true }] };
  }
}

// Each entry directly in a folder by its name, and those below it by the name of the folder that
// holds them.
function byLevel<T extends { readonly relativePath: string }>(entries: readonly T[], prefix: string) {
  const here = new Map<string, T>();
  const below = new Map<string, T[]>();
  for (const entry of entries) {
    const rest = entry.relativePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      here.set(rest, entry);
      continue;
    }
    const name = rest.slice(0, slash);
    below.set(name, [...below.get(name) ?? [], entry]);
  }
  return { here, below };
}

/** The folders, then the files, directly in `parent`, each by name. `files` and `folders` are
 *  those under it, and `path` is its own path in its mod, none for the mod or Overwrite itself. */
export function filesIn(
  parent: ModlistNode, origin: FileOrigin, files: readonly OriginFile[], folders: readonly OriginFolder[], path?: string,
  filter?: { shown: ChildrenShown; matches: NameMatch; inConflict?: (origin: FileOrigin, file: OriginFile) => boolean },
): (FolderNode | FileNode)[] {
  const prefix = path === undefined ? '' : `${path}/`;
  const ownFiles = byLevel(files, prefix);
  const ownFolders = byLevel(folders, prefix);
  return [
    ...[...ownFolders.here].sort(byName).map(([name, folder]) => new FolderNode(
      parent, origin, folder, ownFiles.below.get(name) ?? [], ownFolders.below.get(name) ?? [], name,
      filter ? shownUnder(filter.shown, filter.matches, name) : 'all',
    )),
    ...[...ownFiles.here].sort(byName).map(([name, file]) => new FileNode(parent, origin, file, name, filter?.inConflict?.(origin, file))),
  ];
}
