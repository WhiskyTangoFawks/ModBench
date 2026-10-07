// mods.md, The tree, stories 8 to 10: the grey on a file the game does not get, in the tree and
// in the Explorer.

import * as vscode from 'vscode';
import type { FileOrigin, InstanceValue, InstanceView, OriginFile, OriginFolder } from '../instanceLoader/instance';
import { modOrigin, RUNTIME_OUTPUT, sameOrigin } from '../instanceLoader/fileConflictIndex';
import { fileRowUri } from './modFiles';
import type { WorkspaceSettings } from './workspaceSettings';

/** The setting that switches the grey, on by default (mods.md, Indicators). */
export const GREY_INACTIVE_FILES_SETTING = 'modbench.mods.greyInactiveFiles';

type FilesValue = Pick<InstanceValue, 'mods' | 'files' | 'filesByMod' | 'foldersByMod' | 'overwriteFiles' | 'overwriteFolders'>;

const isNotDeployed = (enabled: boolean, entry: OriginFolder): boolean => !enabled || entry.excluded;

function isFileNotGotten(value: FilesValue, origin: FileOrigin, enabled: boolean, file: OriginFile): boolean {
  const winner = value.files.get(file.relativePath)?.winnerOrigin;
  return isNotDeployed(enabled, file) || (winner !== undefined && !sameOrigin(winner, origin));
}

/** Each file and folder the game does not get: another copy wins its path, it is excluded, or its
 *  mod is disabled. A folder never loses: the game merges folders. By the URI of its row in the
 *  Mods tree and by its own, where the Explorer shows it. */
function inactiveFiles(value: FilesValue): ReadonlySet<string> {
  const inactive = new Set<string>();
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
    for (const file of files) add(origin, file, isFileNotGotten(value, origin, enabled, file));
  }
  return inactive;
}

/** VS Code never re-queries a decoration provider on its own, so this one fires on every new
 *  instance value (ADR-0003) and on every change to its setting. */
export class InactiveFileDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private inactive: ReadonlySet<string> | undefined;
  private readonly subscriptions: readonly vscode.Disposable[];

  constructor(private readonly instance: Pick<InstanceView, 'value' | 'subscribe'>, private readonly setting: WorkspaceSettings) {
    this.subscriptions = [
      instance.subscribe(() => {
        this.inactive = undefined;
        this.changed.fire(undefined);
      }),
      setting.onDidChangeConfiguration((change) => {
        if (change.affectsConfiguration(GREY_INACTIVE_FILES_SETTING)) this.changed.fire(undefined);
      }),
    ];
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (this.setting.getConfiguration().get(GREY_INACTIVE_FILES_SETTING) === false) return undefined;
    this.inactive ??= inactiveFiles(this.instance.value);
    return this.inactive.has(uri.toString()) ? { color: new vscode.ThemeColor('disabledForeground') } : undefined;
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changed.dispose();
  }
}
