// mods.md, The tree, stories 8 to 10: the grey on a file the game does not get, in the tree and
// in the Explorer.

import * as vscode from 'vscode';
import type { FileOrigin, InstanceValue, InstanceView, OriginFile, OriginFolder } from '../instanceLoader/instance';
import { modOrigin, RUNTIME_OUTPUT, sameOrigin } from '../instanceLoader/fileConflictIndex';
import { fileRowUri } from './modFiles';

/** Why the game does not get a file: another copy wins its path, it is excluded, or its mod is
 *  disabled. A folder never loses: the game merges folders. */
export type InactiveReason = 'loses' | 'excluded' | 'modDisabled';

/** The setting that switches the grey, on by default (mods.md, Indicators). */
export const GREY_INACTIVE_FILES_SETTING = 'modbench.mods.greyInactiveFiles';

type FilesValue = Pick<InstanceValue, 'mods' | 'files' | 'filesByMod' | 'foldersByMod' | 'overwriteFiles' | 'overwriteFolders'>;

function whyNotDeployed(enabled: boolean, entry: OriginFolder): InactiveReason | undefined {
  if (!enabled) return 'modDisabled';
  return entry.excluded ? 'excluded' : undefined;
}

function whyFileNotGotten(value: FilesValue, origin: FileOrigin, enabled: boolean, file: OriginFile): InactiveReason | undefined {
  const winner = value.files.get(file.relativePath)?.winnerOrigin;
  return whyNotDeployed(enabled, file) ?? (winner !== undefined && !sameOrigin(winner, origin) ? 'loses' : undefined);
}

/** Each file and folder the game does not get, and why, by the URI of its row in the Mods tree and
 *  by its own, where the Explorer shows it. */
export function inactiveFiles(value: FilesValue): ReadonlyMap<string, InactiveReason> {
  const reasons = new Map<string, InactiveReason>();
  const add = (origin: FileOrigin, entry: OriginFolder, why: InactiveReason | undefined) => {
    if (why === undefined) return;
    reasons.set(fileRowUri(origin, entry.relativePath).toString(), why);
    reasons.set(vscode.Uri.file(entry.path).toString(), why);
  };
  const origins = [
    ...value.mods.flatMap((entry) => (entry.kind === 'mod' ? [{
      origin: modOrigin(entry.name), enabled: entry.enabled,
      files: value.filesByMod.get(entry.name) ?? [], folders: value.foldersByMod.get(entry.name) ?? [],
    }] : [])),
    { origin: RUNTIME_OUTPUT, enabled: true, files: value.overwriteFiles, folders: value.overwriteFolders },
  ];
  for (const { origin, enabled, files, folders } of origins) {
    for (const folder of folders) add(origin, folder, whyNotDeployed(enabled, folder));
    for (const file of files) add(origin, file, whyFileNotGotten(value, origin, enabled, file));
  }
  return reasons;
}

/** The slice of VS Code's workspace the Mods view's settings are read through. */
export interface WorkspaceSettings {
  getConfiguration(): { get(key: string): unknown };
  readonly onDidChangeConfiguration: vscode.Event<{ affectsConfiguration(section: string): boolean }>;
}

/** VS Code never re-queries a decoration provider on its own, so this one fires on every new
 *  instance value (ADR-0003) and on every change to its setting. */
export class InactiveFileDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private reasons: ReadonlyMap<string, InactiveReason> | undefined;
  private readonly subscriptions: readonly vscode.Disposable[];

  constructor(private readonly instance: Pick<InstanceView, 'value' | 'subscribe'>, private readonly setting: WorkspaceSettings) {
    this.subscriptions = [
      instance.subscribe(() => {
        this.reasons = undefined;
        this.changed.fire(undefined);
      }),
      setting.onDidChangeConfiguration((change) => {
        if (change.affectsConfiguration(GREY_INACTIVE_FILES_SETTING)) this.changed.fire(undefined);
      }),
    ];
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (this.setting.getConfiguration().get(GREY_INACTIVE_FILES_SETTING) === false) return undefined;
    this.reasons ??= inactiveFiles(this.instance.value);
    return this.reasons.has(uri.toString()) ? { color: new vscode.ThemeColor('disabledForeground') } : undefined;
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changed.dispose();
  }
}
