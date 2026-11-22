// mods.md, The tree, stories 8 to 10: the grey on a file the game does not get, in the tree and
// in the Explorer.

import * as vscode from 'vscode';
import type { FileOrigin, InstanceValue, InstanceView, OriginFolder } from '../instanceLoader/instance';
import { originKey } from '../instanceLoader/fileConflictIndex';
import { originsTouched } from './originsTouched';
import { RowsByOwner, touchedIn, type Owned, type Row } from './modIndicators';
import { fileRowUri } from './modFiles';
import { archiveGotten, archivedFilesOf, isFileNotGotten, isNotDeployed } from './modFileStates';
import { onSettingChange } from '../drivingLib/setting';
import type { WorkspaceSettings } from './workspaceSettings';

/** The setting that switches the grey, on by default (mods.md, Indicators).
 *  @public Read by packageJson.test, which holds package.json to it. */
export const GREY_INACTIVE_FILES_SETTING = 'modbench.mods.greyInactiveFiles';

const FILES_READ = {
  mods: true, files: true, filesByMod: true, foldersByMod: true, overwriteFiles: true, overwriteFolders: true, archiveContents: true, loadsArchive: true,
  stackedCopies: true, dataFolderFiles: true,
} as const;
type FilesValue = Pick<InstanceValue, keyof typeof FILES_READ>;

// A row the game does not get the file or folder of, or the row of an archive whose files it does not get: each row below
// one is inactive.
interface Inactive {
  readonly inactive: boolean;
  readonly archive: boolean;
}

const sameInactive = (a: Inactive, b: Inactive): boolean => a.inactive === b.inactive && a.archive === b.archive;

const listedFor = (value: FilesValue, origin: FileOrigin, enabledMods: ReadonlySet<string>) => (origin.kind === 'mod'
  ? { enabled: enabledMods.has(origin.name), files: value.filesByMod.get(origin.name) ?? [], folders: value.foldersByMod.get(origin.name) ?? [] }
  : { enabled: true, files: value.overwriteFiles, folders: value.overwriteFolders });

// A folder never loses: the game merges folders.
function ownedBy(value: FilesValue, origin: FileOrigin, enabledMods: ReadonlySet<string>): Owned<Inactive> {
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
  const { enabled, files, folders } = listedFor(value, origin, enabledMods);
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

const ownedIn = (value: FilesValue, touched: 'every' | readonly FileOrigin[]): Owned<Inactive>[] => {
  const enabledMods = new Set(value.mods.flatMap((entry) => (entry.kind === 'mod' && entry.enabled ? [entry.name] : [])));
  return touchedIn(value, touched).map((origin) => ownedBy(value, origin, enabledMods));
};

/** VS Code never re-queries a decoration provider on its own, so this one fires on every new instance value (ADR-0003), for
 *  the rows of the origins it touches, and on every change to its setting. */
export class InactiveFileDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private readonly rows = new RowsByOwner<Inactive>(sameInactive);
  private held: FilesValue | undefined;
  private readonly subscriptions: readonly vscode.Disposable[];

  constructor(private readonly instance: Pick<InstanceView, 'value' | 'subscribe'>, private readonly setting: WorkspaceSettings) {
    this.subscriptions = [
      instance.subscribe((value) => {
        const touched = originsTouched(this.held, value, FILES_READ);
        if (touched === 'every') this.rows.clear();
        this.held = value;
        const changed = this.rows.hold(ownedIn(value, touched));
        if (touched === 'every') this.changed.fire(undefined);
        else if (changed.length > 0) this.changed.fire(changed);
      }, FILES_READ),
      onSettingChange(setting.onDidChangeConfiguration, GREY_INACTIVE_FILES_SETTING, () => { this.changed.fire(undefined); }),
    ];
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (this.setting.getConfiguration().get(GREY_INACTIVE_FILES_SETTING) === false) return undefined;
    if (this.held === undefined) {
      this.held = this.instance.value;
      this.rows.hold(ownedIn(this.held, 'every'));
    }
    const row = uri.toString();
    return this.rows.get(row)?.inactive === true || this.isUnderArchive(row) ? { color: new vscode.ThemeColor('disabledForeground') } : undefined;
  }

  private isUnderArchive(uri: string): boolean {
    for (let end = uri.lastIndexOf('/'); end > 0; end = uri.lastIndexOf('/', end - 1)) {
      if (this.rows.get(uri.slice(0, end))?.archive === true) return true;
    }
    return false;
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changed.dispose();
  }
}
