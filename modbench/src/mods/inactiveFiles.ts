// mods.md, The tree, stories 8 to 10: the grey on a file the game does not get, in the tree and
// in the Explorer.

import * as vscode from 'vscode';
import type { FileOrigin, InstanceValue, InstanceView, OriginFolder } from '../instanceLoader/instance';
import { modOrigin, RUNTIME_OUTPUT } from '../instanceLoader/fileConflictIndex';
import { fileRowUri } from './modFiles';
import { isFileNotGotten, isNotDeployed } from '../drivingLib/modFileStates';
import { onSettingChange } from '../drivingLib/setting';
import type { WorkspaceSettings } from './workspaceSettings';

/** The setting that switches the grey, on by default (mods.md, Indicators).
 *  @public Read by packageJson.test, which holds package.json to it. */
export const GREY_INACTIVE_FILES_SETTING = 'modbench.mods.greyInactiveFiles';

type FilesValue = Pick<InstanceValue, 'mods' | 'files' | 'filesByMod' | 'foldersByMod' | 'overwriteFiles' | 'overwriteFolders' | 'archiveContents' | 'loadsArchive'>;

interface Inactive {
  readonly rows: ReadonlySet<string>;
  /** The rows of the archives whose files the game does not get: every row below one is inactive. */
  readonly archives: ReadonlySet<string>;
}

// A folder never loses: the game merges folders.
function inactiveFiles(value: FilesValue): Inactive {
  const inactive = new Set<string>();
  const archives = new Set<string>();
  const add = (origin: FileOrigin, entry: OriginFolder, isInactive: boolean) => {
    if (!isInactive) return;
    inactive.add(fileRowUri(origin, entry.relativePath).toString());
    inactive.add(vscode.Uri.file(entry.path).toString());
  };
  const origins = [
    ...value.mods.flatMap((entry) => (entry.kind === 'mod' ? [{
      origin: modOrigin(entry.name), enabled: entry.enabled,
      files: value.filesByMod.get(entry.name) ?? [], folders: value.foldersByMod.get(entry.name) ?? [],
    }] : [])),
    { origin: RUNTIME_OUTPUT, enabled: true, files: value.overwriteFiles, folders: value.overwriteFolders },
  ];
  for (const { origin, enabled, files, folders } of origins) {
    for (const folder of folders) add(origin, folder, isNotDeployed(enabled, folder));
    for (const file of files) {
      const notGotten = isFileNotGotten(value, origin, enabled, file);
      add(origin, file, notGotten);
      if (value.archiveContents.has(file.sourcePath) && (notGotten || !value.loadsArchive(file.relativePath))) {
        archives.add(fileRowUri(origin, file.relativePath).toString());
      }
    }
  }
  return { rows: inactive, archives };
}

function isUnder(archives: ReadonlySet<string>, uri: string): boolean {
  for (let end = uri.lastIndexOf('/'); end > 0; end = uri.lastIndexOf('/', end - 1)) {
    if (archives.has(uri.slice(0, end))) return true;
  }
  return false;
}

/** VS Code never re-queries a decoration provider on its own, so this one fires on every new
 *  instance value (ADR-0003) and on every change to its setting. */
export class InactiveFileDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private inactive: Inactive | undefined;
  private readonly subscriptions: readonly vscode.Disposable[];

  constructor(private readonly instance: Pick<InstanceView, 'value' | 'subscribe'>, private readonly setting: WorkspaceSettings) {
    this.subscriptions = [
      instance.subscribe(() => {
        this.inactive = undefined;
        this.changed.fire(undefined);
      }),
      onSettingChange(setting.onDidChangeConfiguration, GREY_INACTIVE_FILES_SETTING, () => { this.changed.fire(undefined); }),
    ];
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (this.setting.getConfiguration().get(GREY_INACTIVE_FILES_SETTING) === false) return undefined;
    this.inactive ??= inactiveFiles(this.instance.value);
    const row = uri.toString();
    return this.inactive.rows.has(row) || isUnder(this.inactive.archives, row) ? { color: new vscode.ThemeColor('disabledForeground') } : undefined;
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changed.dispose();
  }
}
