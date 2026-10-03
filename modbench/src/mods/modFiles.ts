// mods.md, A row, File and folder: a mod's or Overwrite's files, as a folder tree.

import * as vscode from 'vscode';
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

/** No expander on a row with no files under it. */
export const expanderOver = (files: readonly OriginFile[]): vscode.TreeItemCollapsibleState =>
  (files.length === 0 ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);

function fileRow(row: vscode.TreeItem, parent: ModlistNode, name: string, path: string): void {
  row.id = `${parent.id}/${name}`;
  row.resourceUri = vscode.Uri.from({ scheme: FILE_ROW_SCHEME, path: `/${row.id}` });
  row.tooltip = path;
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
  ) {
    super(name, expanderOver(files));
    fileRow(this, parent, name, folder.relativePath);
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
  ) {
    super(name, vscode.TreeItemCollapsibleState.None);
    fileRow(this, parent, name, file.relativePath);
    this.contextValue = 'file';
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
): (FolderNode | FileNode)[] {
  const prefix = path === undefined ? '' : `${path}/`;
  const ownFiles = byLevel(files, prefix);
  const ownFolders = byLevel(folders, prefix);
  return [
    ...[...ownFolders.here].sort(byName).map(([name, folder]) => new FolderNode(
      parent, origin, folder, ownFiles.below.get(name) ?? [], ownFolders.below.get(name) ?? [], name,
    )),
    ...[...ownFiles.here].sort(byName).map(([name, file]) => new FileNode(parent, origin, file, name)),
  ];
}
