// mods.md, A row, File and folder: a mod's or Overwrite's files, as a folder tree.

import * as vscode from 'vscode';
import type { FileOrigin, OriginFile, OriginFolder } from '../instanceLoader/instance';
import { originLabel, type FileOrderConflict } from '../instanceLoader/fileConflictIndex';
import type { ModlistNode } from './ModListProvider';
import type { OriginFileMark, OriginFileRef } from '../modCommands/modCommands';
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

/** A file in an archive, by its path there. */
export interface ArchivedEntry {
  readonly relativePath: string;
}

/** What an archive holds; none for a file that is no archive mEdit read. */
export type ArchivedOf = (file: OriginFile) => readonly ArchivedEntry[];

const named = (archivedOf: ArchivedOf, matches: NameMatch) => (file: OriginFile): boolean =>
  pathNamed(file.relativePath, matches) || archivedOf(file).some((entry) => pathNamed(entry.relativePath, matches));

export function anyNamed(files: readonly OriginFile[], folders: readonly OriginFolder[], matches: NameMatch, archivedOf: ArchivedOf): boolean {
  return files.some(named(archivedOf, matches)) || folders.some((folder) => pathNamed(folder.relativePath, matches));
}

export function narrowToMatches(
  files: readonly OriginFile[], folders: readonly OriginFolder[], matches: NameMatch, archivedOf: ArchivedOf,
): { files: OriginFile[]; folders: OriginFolder[] } {
  const foundFiles = files.filter(named(archivedOf, matches));
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

// instance-repository.md, Status, story 1; The manifest, story 11.
function sayingWhetherItDiffers<T extends vscode.TreeItem>(row: T, differs: boolean | undefined): T {
  if (differs === true) row.description = 'differs';
  return row;
}

// What the publisher tag items read: none is offered in Overwrite, and remove is offered on a row that holds one.
const publisherFlags = (origin: FileOrigin, holdsPublisherTag: boolean): string[] =>
  [origin.kind === 'runtimeOutput' && 'inOverwrite', holdsPublisherTag && 'holdsPublisherTag'].filter((flag) => flag !== false);

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
    holdsPublisherTag = false,
  ) {
    super(name, expanderOver([...files, ...folders], shown));
    fileRow(this, parent, origin, name, folder.relativePath);
    this.contextValue = ['folder', ...publisherFlags(origin, holdsPublisherTag)].join(' ');
  }
}

/** Each mark's verb, and the state of a file whose own name carries it. */
export const FILE_MARKS = {
  Excluded: { verb: 'exclude', state: 'excluded' },
  Included: { verb: 'include', state: 'included' },
} as const satisfies Record<OriginFileMark, { verb: string; state: string }>;

type FileExclusion = (typeof FILE_MARKS)[OriginFileMark]['state'];

/** How a message names a file: its mod or Overwrite, and its path there. */
export const fileLabel = ({ origin, relativePath }: OriginFileRef): string => `${originLabel(origin)}/${relativePath}`;

/** Whether the manifest ignores a file: not at all, through a folder above it, or by an entry of its own path. */
export type FileIgnore = 'unignored' | 'under' | 'entry';

const IGNORE_CONTEXT: Record<FileIgnore, readonly string[]> = { unignored: [], under: ['ignored'], entry: ['ignored', 'ignoreEntry'] };

export class FileNode extends vscode.TreeItem {
  readonly kind = 'file' as const;
  readonly exclusion: FileExclusion;
  readonly ignoring: FileIgnore;
  archived: { readonly entries: readonly ArchivedEntry[]; readonly shown: ChildrenShown } | undefined;
  constructor(
    public readonly parent: ModlistNode,
    public readonly origin: FileOrigin,
    public readonly file: OriginFile,
    name: string,
    public readonly conflict: FileOrderConflict = 'none',
    holdsPublisherTag = false,
    ignoring: FileIgnore = 'unignored',
  ) {
    super(name, vscode.TreeItemCollapsibleState.None);
    fileRow(this, parent, origin, name, file.relativePath);
    this.exclusion = FILE_MARKS[file.markedExcluded ? 'Excluded' : 'Included'].state;
    this.ignoring = ignoring;
    if (ignoring !== 'unignored') this.description = 'ignored';
    this.contextValue = ['file', conflict !== 'none' && 'conflict', conflict === 'loses' && 'losing', this.exclusion, ...IGNORE_CONTEXT[ignoring], ...publisherFlags(origin, holdsPublisherTag)].filter(Boolean).join(' ');
    this.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(file.path), { preview: true }] };
  }

  get ref(): OriginFileRef {
    return { origin: this.origin, relativePath: this.file.relativePath };
  }
}

// mods.md, The tree, story 13.
function openingIntoItsFiles(row: FileNode, entries: readonly ArchivedEntry[], shown: ChildrenShown): FileNode {
  if (entries.length === 0) return row;
  row.archived = { entries, shown };
  row.collapsibleState = expanderOver(entries, shown);
  row.command = undefined;
  return row;
}

function archivedRow(row: vscode.TreeItem, parent: ModlistNode, archive: FileNode, name: string, path: string): void {
  const inMod = `${archive.file.relativePath}/${path}`;
  row.id = `${parent.id}/${name}`;
  row.resourceUri = fileRowUri(archive.origin, inMod);
  row.tooltip = inMod;
}

/** A folder in an archive, and the files below it. */
export class ArchivedFolderNode extends vscode.TreeItem {
  readonly kind = 'archivedFolder' as const;
  constructor(
    public readonly parent: FileNode | ArchivedFolderNode,
    public readonly archive: FileNode,
    public readonly path: string,
    public readonly entries: readonly ArchivedEntry[],
    name: string,
    public readonly shown: ChildrenShown,
  ) {
    super(name, expanderOver(entries, shown));
    archivedRow(this, parent, archive, name, path);
    this.contextValue = this.kind;
  }
}

export class ArchivedFileNode extends vscode.TreeItem {
  readonly kind = 'archivedFile' as const;
  constructor(public readonly parent: FileNode | ArchivedFolderNode, public readonly archive: FileNode, path: string, name: string) {
    super(name, vscode.TreeItemCollapsibleState.None);
    archivedRow(this, parent, archive, name, path);
    this.contextValue = this.kind;
  }
}

/** The folders, then the files, directly in an archive or a folder in it, each by name. */
export function archivedIn(parent: FileNode | ArchivedFolderNode, matches: NameMatch): (ArchivedFolderNode | ArchivedFileNode)[] {
  const [archive, prefix, { entries, shown }] = parent instanceof FileNode
    ? [parent, '', parent.archived ?? { entries: [], shown: 'all' as const }]
    : [parent.archive, `${parent.path}/`, parent];
  const { here, below } = byLevel(entries, prefix);
  return [
    ...[...below].sort(byName).map(([name, under]) => new ArchivedFolderNode(parent, archive, `${prefix}${name}`, under, name, shownUnder(shown, matches, name))),
    ...[...here].sort(byName).map(([name, entry]) => new ArchivedFileNode(parent, archive, entry.relativePath, name)),
  ];
}

/** The folders, then the files, directly in `parent`, each by name. `files` and `folders` are
 *  those under it, and `path` is its own path in its mod, none for the mod or Overwrite itself. */
export function filesIn(
  parent: ModlistNode, origin: FileOrigin, files: readonly OriginFile[], folders: readonly OriginFolder[], path?: string,
  filter?: {
    shown: ChildrenShown; matches: NameMatch; conflict: (origin: FileOrigin, file: OriginFile) => FileOrderConflict;
    differs: (origin: FileOrigin, relativePath: string) => boolean;
    ignored: (origin: FileOrigin, file: OriginFile) => FileIgnore;
    holdsPublisherTag: (path: string) => boolean;
    archived: ArchivedOf;
  },
): (FolderNode | FileNode)[] {
  const archivedShown = (file: OriginFile, name: string): [readonly ArchivedEntry[], ChildrenShown] => {
    if (filter === undefined) return [[], 'all'];
    const shown = shownUnder(filter.shown, filter.matches, name);
    const entries = filter.archived(file);
    return [shown === 'matching' ? entries.filter((entry) => pathNamed(entry.relativePath, filter.matches)) : entries, shown];
  };
  const prefix = path === undefined ? '' : `${path}/`;
  const ownFiles = byLevel(files, prefix);
  const ownFolders = byLevel(folders, prefix);
  return [
    ...[...ownFolders.here].sort(byName).map(([name, folder]) => sayingWhetherItDiffers(new FolderNode(
      parent, origin, folder, ownFiles.below.get(name) ?? [], ownFolders.below.get(name) ?? [], name,
      filter ? shownUnder(filter.shown, filter.matches, name) : 'all', filter?.holdsPublisherTag(folder.path),
    ), filter?.differs(origin, folder.relativePath))),
    ...[...ownFiles.here].sort(byName).map(([name, file]) =>
      sayingWhetherItDiffers(openingIntoItsFiles(
        new FileNode(parent, origin, file, name, filter?.conflict(origin, file), filter?.holdsPublisherTag(file.path), filter?.ignored(origin, file)),
        ...archivedShown(file, name),
      ), filter?.differs(origin, file.relativePath))),
  ];
}
