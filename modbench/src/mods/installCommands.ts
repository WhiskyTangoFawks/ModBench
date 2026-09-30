// The Mods view's install gesture: a new mod from an archive or a folder the user picks.

import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';
import {
  ARCHIVE_EXTENSIONS, defaultModName, defaultModNameForFolder, installFromArchive, installFromFolder,
  type InstallAccess,
} from '../install/install';
import type { ModlistAccess } from '../modlist/modlist';
import { collidingModName } from './modNameCollision';

/** What the gesture answers its invoker: whether a mod landed. A cancelled picker, a cancelled
 *  name prompt and a refused install are one answer, since each leaves nothing installed. */
export interface InstallOutcome {
  installed: boolean;
}
const NOT_INSTALLED: InstallOutcome = { installed: false };

export interface ModInstallDeps {
  /** A new mod's name is checked against mod order as modlist commands match names. */
  access: InstallAccess & ModlistAccess;
  instance: Pick<Instance, 'value'>;
  runModAction: (label: string, failMessage: string, action: () => Promise<void>) => Promise<void>;
  promptModName: (defaultName: string, validate?: (value: string) => string | undefined) => Thenable<string | undefined>;
  warnIfFomod: (name: string, isFomod: boolean) => void;
}

interface SourceKindItem extends vscode.QuickPickItem {
  sourceKind: 'archive' | 'folder';
}

// modbench.mod.install: the Mods menu supplies no source, so it asks archive-or-folder first,
// before either OS picker opens (mods.md, Create empty mod and install, story 2).
export function registerModInstallCommands(deps: ModInstallDeps): vscode.Disposable[] {
  const { access, instance, runModAction, promptModName, warnIfFomod } = deps;
  const validateName = (name: string) => collidingModName(access, instance, name);
  const installArchive = async (archivePath: string): Promise<InstallOutcome> => {
    const name = await promptModName(defaultModName(archivePath), validateName);
    if (!name) return NOT_INSTALLED;
    let succeeded = false;
    await runModAction('installFromArchive', `Failed to install "${name}".`, async () => {
      const outcome = await installFromArchive(
        access.instanceRoot, { kind: 'new', name }, archivePath, instance.value.paths.downloadsDir,
        { gameName: instance.value.gameRelease });
      if (!outcome.applied) throw new Error(outcome.refusal);
      warnIfFomod(name, outcome.isFomod);
      succeeded = true;
    });
    return { installed: succeeded };
  };
  const installFolder = async (folder: string): Promise<InstallOutcome> => {
    const name = await promptModName(defaultModNameForFolder(folder), validateName);
    if (!name) return NOT_INSTALLED;
    let succeeded = false;
    await runModAction('installFromFolder', `Failed to install "${name}".`, async () => {
      const outcome = await installFromFolder(access.instanceRoot, { kind: 'new', name }, folder, { gameName: instance.value.gameRelease });
      if (!outcome.applied) throw new Error(outcome.refusal);
      warnIfFomod(name, outcome.isFomod);
      succeeded = true;
    });
    return { installed: succeeded };
  };
  return [
    vscode.commands.registerCommand('modbench.mod.install', async (): Promise<InstallOutcome> => {
      const picked = await vscode.window.showQuickPick<SourceKindItem>(
        [
          { label: 'Archive…', description: 'A .zip, .7z or .rar file', sourceKind: 'archive' },
          { label: 'Folder…', description: 'An already-extracted mod folder', sourceKind: 'folder' },
        ],
        { placeHolder: 'Install a mod from an archive or a folder' },
      );
      if (!picked) return NOT_INSTALLED;
      if (picked.sourceKind === 'archive') {
        const archivePicked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { 'Mod archives': [...ARCHIVE_EXTENSIONS] },
          openLabel: 'Install',
        });
        const archive = archivePicked?.[0]?.fsPath;
        return archive ? installArchive(archive) : NOT_INSTALLED;
      }
      const folderPicked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Install',
      });
      const folder = folderPicked?.[0]?.fsPath;
      return folder ? installFolder(folder) : NOT_INSTALLED;
    }),
  ];
}
