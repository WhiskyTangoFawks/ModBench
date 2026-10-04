// mods.md, A row, File and folder: a mod's or Overwrite's files, as a folder tree.

import * as vscode from 'vscode';
import type { FileOrigin, OriginFile, OriginFolder } from '../instanceLoader/instance';
import { originLabel } from '../instanceLoader/fileConflictIndex';
import type { ModlistNode } from './ModListProvider';
import type { OriginFileMark, OriginFileRef } from '../modlist/modlist';
import { byLevel, byName } from './fileTree';

// Not `file:`: VS Code badges and tints a row whose resourceUri carries a diagnostic or another
// provider's file decoration, and a file row draws neither. The file icon theme reads the name
// from the URI's last segment.
const FILE_ROW_SCHEME = 'modbench-mod-file';

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

/** Each mark's verb, and the state of a file whose own name carries it. */
export const FILE_MARKS = {
  Excluded: { verb: 'exclude', state: 'excluded' },
  Included: { verb: 'include', state: 'included' },
} as const satisfies Record<OriginFileMark, { verb: string; state: string }>;

/** The file's own name, as the reference tool reads it to offer one of the pair: excluded offers
 *  include, and included offers exclude, whatever its folder. */
export type FileExclusion = (typeof FILE_MARKS)[OriginFileMark]['state'];

/** How a message names a file: its mod or Overwrite, and its path there. */
export const fileLabel = ({ origin, relativePath }: OriginFileRef): string => `${originLabel(origin)}/${relativePath}`;

export class FileNode extends vscode.TreeItem {
  readonly kind = 'file' as const;
  readonly exclusion: FileExclusion;
  constructor(
    public readonly parent: ModlistNode,
    public readonly origin: FileOrigin,
    public readonly file: OriginFile,
    name: string,
    public readonly inConflict = false,
  ) {
    super(name, vscode.TreeItemCollapsibleState.None);
    fileRow(this, parent, origin, name, file.relativePath);
    this.exclusion = FILE_MARKS[file.excludedByName ? 'Excluded' : 'Included'].state;
    this.contextValue = ['file', inConflict && 'conflict', this.exclusion].filter(Boolean).join(' ');
    this.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(file.path), { preview: true }] };
  }

  get ref(): OriginFileRef {
    return { origin: this.origin, relativePath: this.file.relativePath };
  }
}

/** The folders, then the files, directly in `parent`, each by name. `files` and `folders` are
 *  those under it, and `path` is its own path in its mod, none for the mod or Overwrite itself. */
export function filesIn(
  parent: ModlistNode, origin: FileOrigin, files: readonly OriginFile[], folders: readonly OriginFolder[], path?: string,
  filter?: { shown: ChildrenShown; matches: NameMatch; inConflict: (origin: FileOrigin, file: OriginFile) => boolean },
): (FolderNode | FileNode)[] {
  const prefix = path === undefined ? '' : `${path}/`;
  const ownFiles = byLevel(files, prefix);
  const ownFolders = byLevel(folders, prefix);
  return [
    ...[...ownFolders.here].sort(byName).map(([name, folder]) => new FolderNode(
      parent, origin, folder, ownFiles.below.get(name) ?? [], ownFolders.below.get(name) ?? [], name,
      filter ? shownUnder(filter.shown, filter.matches, name) : 'all',
    )),
    ...[...ownFiles.here].sort(byName).map(([name, file]) => new FileNode(parent, origin, file, name, filter?.inConflict(origin, file))),
  ];
}
