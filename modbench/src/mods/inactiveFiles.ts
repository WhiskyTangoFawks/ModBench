// mods.md, The tree, stories 8 to 10: the grey on a file the game does not get, in the tree and
// in the Explorer.

import * as vscode from 'vscode';
import { DecorationRedrawEmitter } from '../drivingLib/heldRedraw';
import { MODS_KEY_ARGS } from './gestureEntry';
import type { FileOrigin, InstanceValue, InstanceView, OriginFile, OriginFolder } from '../instanceLoader/instance';
import { foldedFilesIn, foldPath, originKey, sameOrigin } from '../instanceLoader/fileConflictIndex';
import { modEntryOf, RowsByOwner, rowsFollowing, touchedIn, type OriginsChange, type Owned, type Row } from './originsTouched';
import { TOUCHING_READ, type FilesChanged } from '../instanceLoader/filesChanged';
import { fileRowUri } from './modFiles';
import { archiveGotten, archivedFileOf, archivedFilesOf, isFileNotGotten, isNotDeployed, type ArchivedFileStanding } from './modFileStates';
import { onSettingChange } from '../drivingLib/setting';
import type { WorkspaceSettings } from './workspaceSettings';

type OwnChange = Exclude<FilesChanged, 'every'>[number];

/** The setting that switches the grey, on by default (mods.md, Indicators).
 *  @public Read by packageJson.test, which holds package.json to it. */
export const GREY_INACTIVE_FILES_SETTING = 'modbench.mods.greyInactiveFiles';

const FILES_READ = { ...TOUCHING_READ, mods: true, dataFolderFiles: true } as const;
type FilesValue = Pick<InstanceValue, keyof typeof FILES_READ>;

// A row the game does not get the file or folder of, or the row of an archive whose files it does not get: each row below
// one is inactive.
interface Inactive {
  readonly inactive: boolean;
  readonly archive: boolean;
}

const sameInactive = (a: Inactive, b: Inactive): boolean => a.inactive === b.inactive && a.archive === b.archive;

const listedFor = (value: FilesValue, origin: FileOrigin) => (origin.kind === 'mod'
  ? { enabled: modEntryOf(value.mods, origin.name)?.enabled === true, files: value.filesByMod.get(origin.name) ?? [], folders: value.foldersByMod.get(origin.name) ?? [] }
  : { enabled: true, files: value.overwriteFiles, folders: value.overwriteFolders });

type Rows = Map<string, Row<Inactive>>;

const mark = (rows: Rows, uri: vscode.Uri, kind: keyof Inactive): void => {
  const key = uri.toString();
  rows.set(key, { uri, carried: { inactive: false, archive: false, ...rows.get(key)?.carried, [kind]: true } });
};

const markInactive = (rows: Rows, origin: FileOrigin, entry: OriginFolder): void => {
  mark(rows, fileRowUri(origin, entry.relativePath), 'inactive');
  mark(rows, vscode.Uri.file(entry.path), 'inactive');
};

// A folder never loses: the game merges folders.
function folderRows(value: FilesValue, origin: FileOrigin): Owned<Inactive> {
  const rows: Rows = new Map();
  const { enabled, folders } = listedFor(value, origin);
  for (const folder of folders) if (isNotDeployed(enabled, folder)) markInactive(rows, origin, folder);
  return [`${originKey(origin)}\0folders`, rows];
}

// The rows of the origin's file at the path: the file's own, and of an archive, each file it holds, under its own owner.
function * fileRows(value: FilesValue, origin: FileOrigin, relativePath: string, file: OriginFile | undefined): Iterable<Owned<Inactive>> {
  const rows: Rows = new Map();
  const { enabled } = listedFor(value, origin);
  if (file !== undefined && isFileNotGotten(value, origin, enabled, file)) markInactive(rows, origin, file);
  const archive = file !== undefined && value.archiveContents.has(file.sourcePath);
  if (archive && !archiveGotten(value, origin, enabled, file)) mark(rows, fileRowUri(origin, file.relativePath), 'archive');
  yield [`${originKey(origin)}\0${relativePath}`, rows];
  if (archive) for (const standing of archivedFilesOf(value, origin, enabled, file)) yield archivedRows(origin, file, standing);
}

function archivedRows(origin: FileOrigin, archive: OriginFile, { path, gotten }: ArchivedFileStanding): Owned<Inactive> {
  const rows: Rows = new Map();
  if (!gotten) mark(rows, fileRowUri(origin, `${archive.relativePath}/${path}`), 'inactive');
  return [`${originKey(origin)}\0${archive.relativePath}\0${path}`, rows];
}

// Each origin's archives by the path they are read from, kept while what the archives hold is the same.
const archivesHeld = new WeakMap<FilesValue['archiveContents'], Map<string, ReadonlyMap<string, OriginFile>>>();

function archiveOf(value: FilesValue, origin: FileOrigin, sourcePath: string): OriginFile | undefined {
  let byOrigin = archivesHeld.get(value.archiveContents);
  if (byOrigin === undefined) {
    byOrigin = new Map();
    archivesHeld.set(value.archiveContents, byOrigin);
  }
  let archives = byOrigin.get(originKey(origin));
  if (archives === undefined) {
    archives = new Map(listedFor(value, origin).files.flatMap((file) => (value.archiveContents.has(file.sourcePath) ? [[file.sourcePath, file] as const] : [])));
    byOrigin.set(originKey(origin), archives);
  }
  return archives.get(sourcePath);
}

// The rows of each file the origin's archives hold at the path.
function * archivedAt(value: FilesValue, origin: FileOrigin, path: string): Iterable<Owned<Inactive>> {
  for (const { origin: holder, at } of value.stackedCopies.get(path)?.copies ?? []) {
    if (at.kind !== 'archived' || !sameOrigin(holder, origin)) continue;
    const archive = archiveOf(value, origin, at.archive);
    if (archive === undefined) continue;
    const loaded = archiveGotten(value, origin, listedFor(value, origin).enabled, archive);
    yield archivedRows(origin, archive, archivedFileOf(value, origin, archive, at.file, loaded));
  }
}

// The origin's file at the folded path, as the file conflict index takes it.
const fileAtPath = (files: readonly OriginFile[], folded: string): OriginFile | undefined => foldedFilesIn(files).get(folded);

// The rows of an origin's own change: its folders, and each file it gained or lost, whose folded path joins `done`.
function * ownRows(value: FilesValue, { origin, files, gained }: OwnChange, done: Set<string>): Iterable<Owned<Inactive>> {
  yield folderRows(value, origin);
  const gainedFiles = new Set(gained);
  const gainedAt = new Set(gained.map(({ relativePath }) => relativePath));
  for (const file of files) {
    const isGained = gainedFiles.has(file);
    if (!isGained && gainedAt.has(file.relativePath)) continue;
    done.add(foldPath(file.relativePath));
    yield * fileRows(value, origin, file.relativePath, isGained ? file : undefined);
  }
}

// The rows a change derives again: of each origin it touches, each file it gained or lost, its folders, and at each path
// whose copies changed, its file and its archives' files. Every row while anything changed.
function * ownedIn(value: FilesValue, change: OriginsChange): Iterable<Owned<Inactive>> {
  for (const origin of touchedIn(value, change)) {
    const { files } = listedFor(value, origin);
    if (change === 'every') {
      yield folderRows(value, origin);
      yield * files.flatMap((file) => [...fileRows(value, origin, file.relativePath, file)]);
      continue;
    }
    const own = change.own.find((changed) => sameOrigin(changed.origin, origin));
    const done = new Set<string>();
    if (own !== undefined) yield * ownRows(value, own, done);
    for (const path of change.paths) {
      yield * archivedAt(value, origin, path);
      const file = done.has(foldPath(path)) ? undefined : fileAtPath(files, foldPath(path));
      if (file !== undefined) yield * fileRows(value, origin, file.relativePath, file);
    }
  }
}

/** VS Code never re-queries a decoration provider on its own, so this one fires on every new instance value (ADR-0003), for
 *  the rows of the origins it touches, and on every change to its setting. */
export class InactiveFileDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new DecorationRedrawEmitter(MODS_KEY_ARGS.view);
  readonly onDidChangeFileDecorations = this.changed.event;
  private readonly held: () => RowsByOwner<Inactive>;
  private readonly subscriptions: readonly { dispose(): unknown }[];

  constructor(instance: Pick<InstanceView, 'value' | 'subscribe'>, private readonly setting: WorkspaceSettings) {
    const following = rowsFollowing(instance, FILES_READ, new RowsByOwner(sameInactive), ownedIn, (uris) => { this.changed.fire(uris); });
    this.held = following.held;
    this.subscriptions = [
      following.subscription,
      onSettingChange(setting.onDidChangeConfiguration, GREY_INACTIVE_FILES_SETTING, () => { this.changed.fire(undefined); }),
    ];
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (this.setting.getConfiguration().get(GREY_INACTIVE_FILES_SETTING) === false) return undefined;
    const rows = this.held();
    const row = uri.toString();
    return rows.get(row)?.inactive === true || isUnderArchive(rows, row) ? { color: new vscode.ThemeColor('disabledForeground') } : undefined;
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changed.dispose();
  }
}

function isUnderArchive(rows: RowsByOwner<Inactive>, uri: string): boolean {
  for (let end = uri.lastIndexOf('/'); end > 0; end = uri.lastIndexOf('/', end - 1)) {
    if (rows.get(uri.slice(0, end))?.archive === true) return true;
  }
  return false;
}
