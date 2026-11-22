// mods.md, The tree, stories 8 to 10: the grey on a file the game does not get, in the tree and
// in the Explorer.

import * as vscode from 'vscode';
import { RedrawEmitter } from '../drivingLib/heldRedraw';
import type { FileOrigin, InstanceValue, InstanceView, OriginFolder } from '../instanceLoader/instance';
import { originKey } from '../instanceLoader/fileConflictIndex';
import { modEntryOf, RowsByOwner, rowsFollowing, touchedIn, type Owned, type Row } from './originsTouched';
import { TOUCHING_READ } from '../instanceLoader/filesChanged';
import { fileRowUri } from './modFiles';
import { archiveGotten, archivedFilesOf, isFileNotGotten, isNotDeployed } from './modFileStates';
import { onSettingChange } from '../drivingLib/setting';
import type { WorkspaceSettings } from './workspaceSettings';

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

// A folder never loses: the game merges folders.
function ownedBy(value: FilesValue, origin: FileOrigin): Owned<Inactive> {
  const rows = new Map<string, Row<Inactive>>();
  const mark = (uri: vscode.Uri, mark: keyof Inactive) => {
    const key = uri.toString();
    rows.set(key, { uri, carried: { inactive: false, archive: false, ...rows.get(key)?.carried, [mark]: true } });
  };
  const add = (entry: OriginFolder, isInactive: boolean) => {
    if (!isInactive) return;
    mark(fileRowUri(origin, entry.relativePath), 'inactive');
    mark(vscode.Uri.file(entry.path), 'inactive');
  };
  const { enabled, files, folders } = listedFor(value, origin);
  for (const folder of folders) add(folder, isNotDeployed(enabled, folder));
  for (const file of files) {
    add(file, isFileNotGotten(value, origin, enabled, file));
    if (!value.archiveContents.has(file.sourcePath)) continue;
    if (!archiveGotten(value, origin, enabled, file)) mark(fileRowUri(origin, file.relativePath), 'archive');
    for (const { path, gotten } of archivedFilesOf(value, origin, enabled, file)) {
      if (!gotten) mark(fileRowUri(origin, `${file.relativePath}/${path}`), 'inactive');
    }
  }
  return [originKey(origin), rows];
}

const ownedIn = (value: FilesValue, touched: 'every' | readonly FileOrigin[]): Owned<Inactive>[] => touchedIn(value, touched).map((origin) => ownedBy(value, origin));

/** VS Code never re-queries a decoration provider on its own, so this one fires on every new instance value (ADR-0003), for
 *  the rows of the origins it touches, and on every change to its setting. */
export class InactiveFileDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new RedrawEmitter<vscode.Uri[] | undefined>();
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
