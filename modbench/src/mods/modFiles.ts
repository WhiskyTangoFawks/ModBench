// mods.md, A row, File and folder: a mod's or Overwrite's files, as a folder tree.

import * as vscode from 'vscode';
import type { FileOrigin, ModFile } from '../instanceLoader/instance';
import type { ModlistNode } from './ModListProvider';

// Not `file:`: VS Code badges and tints a row whose resourceUri carries a diagnostic or another
// provider's file decoration, and a file row draws neither. The file icon theme reads the name
// from the URI's last segment.
const FILE_ROW_SCHEME = 'modbench-mod-file';

// The Explorer's default order: case aside, and a run of digits by its value.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byName = ([a]: readonly [string, unknown], [b]: readonly [string, unknown]): number => collator.compare(a, b);

function fileRow(row: vscode.TreeItem, parent: ModlistNode, name: string, path: string): void {
  row.id = `${parent.id}/${name}`;
  row.resourceUri = vscode.Uri.from({ scheme: FILE_ROW_SCHEME, path: `/${row.id}` });
  row.tooltip = path;
}

/** A folder in a mod or Overwrite, and the files under it. */
export class FolderNode extends vscode.TreeItem {
  readonly kind = 'folder' as const;
  constructor(
    public readonly parent: ModlistNode,
    public readonly origin: FileOrigin,
    /** The path in its mod. */
    public readonly path: string,
    public readonly files: readonly ModFile[],
    name: string,
  ) {
    super(name, vscode.TreeItemCollapsibleState.Collapsed);
    fileRow(this, parent, name, path);
    this.contextValue = 'folder';
  }
}

export class FileNode extends vscode.TreeItem {
  readonly kind = 'file' as const;
  constructor(
    public readonly parent: ModlistNode,
    public readonly origin: FileOrigin,
    public readonly file: ModFile,
    name: string,
  ) {
    super(name, vscode.TreeItemCollapsibleState.None);
    fileRow(this, parent, name, file.relativePath);
    this.contextValue = 'file';
  }
}

/** The folders, then the files, directly in `parent`, each by name. `files` are those under it,
 *  and `path` is its own path in its mod, none for the mod or Overwrite itself. */
export function filesIn(
  parent: ModlistNode, origin: FileOrigin, files: readonly ModFile[], path?: string,
): (FolderNode | FileNode)[] {
  const prefix = path === undefined ? '' : `${path}/`;
  const folders = new Map<string, ModFile[]>();
  const leaves: [string, ModFile][] = [];
  for (const file of files) {
    const rest = file.relativePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      leaves.push([rest, file]);
      continue;
    }
    const name = rest.slice(0, slash);
    const under = folders.get(name) ?? [];
    under.push(file);
    folders.set(name, under);
  }
  return [
    ...[...folders].sort(byName).map(([name, under]) => new FolderNode(parent, origin, prefix + name, under, name)),
    ...leaves.sort(byName).map(([name, file]) => new FileNode(parent, origin, file, name)),
  ];
}
