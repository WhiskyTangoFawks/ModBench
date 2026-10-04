// The install gesture: a downloaded file handed as the Argument, or an archive or a folder the user picks.

import * as vscode from 'vscode';
import type { DownloadFile, Instance } from '../instanceLoader/instance';
import {
  ARCHIVE_EXTENSIONS, defaultModName, defaultModNameForFolder, installFromArchive, installFromFolder, installNameRefusal,
  type InstallAccess,
} from '../install/install';
import { runWritingGesture } from '../drivingLib/writingGesture';
import { MODS_KEY_ARGS } from './gestureEntry';

/** What the gesture answers its invoker: whether a mod landed. A cancelled picker, a cancelled
 *  name prompt and a refused install are one answer, since each leaves nothing installed. */
export interface InstallOutcome {
  installed: boolean;
}
const NOT_INSTALLED: InstallOutcome = { installed: false };

export interface ModInstallDeps {
  access: InstallAccess;
  instance: Pick<Instance, 'value' | 'refresh'>;
  runModAction: (label: string, failMessage: string, action: () => Promise<void>) => Promise<void>;
  promptModName: (
    defaultName: string, validate?: (value: string) => Thenable<string | undefined> | string | undefined,
  ) => Thenable<string | undefined>;
  warnIfFomod: (name: string, isFomod: boolean) => void;
  /** The Downloads view's flow for a downloaded file: the target pick, the name and the installed mark.
   *  Answers whether a mod landed. */
  installDownloaded: (file: DownloadFile) => Promise<boolean>;
}

interface DownloadedFileSource {
  kind: 'download';
  row: DownloadFile;
}

function isDownloadedFile(argument: unknown): argument is DownloadedFileSource {
  return typeof argument === 'object' && argument !== null && 'kind' in argument && argument.kind === 'download' && 'row' in argument;
}

interface SourceKindItem extends vscode.QuickPickItem {
  sourceKind: 'archive' | 'folder';
}

// modbench.mod.install: with no source, as from the Mods menu, it asks archive-or-folder first,
// before either OS picker opens (mods.md, Create empty mod and install, story 2).
export function registerModInstallCommands(deps: ModInstallDeps): vscode.Disposable[] {
  const { access, instance, runModAction, promptModName, warnIfFomod, installDownloaded } = deps;
  const runWriting = (command: () => Promise<void>) => runWritingGesture(MODS_KEY_ARGS.view, instance, command);
  const validateName = (name: string) => installNameRefusal(access, name);
  const installArchive = async (archivePath: string): Promise<InstallOutcome> => {
    const name = await promptModName(defaultModName(archivePath), validateName);
    if (!name) return NOT_INSTALLED;
    let succeeded = false;
    await runWriting(() => runModAction('installFromArchive', `Failed to install "${name}".`, async () => {
      const outcome = await installFromArchive(access, { kind: 'new', name }, archivePath, { gameName: instance.value.gameName });
      if (!outcome.applied) throw new Error(outcome.refusal);
      warnIfFomod(name, outcome.isFomod);
      succeeded = true;
    }));
    return { installed: succeeded };
  };
  const installFolder = async (folder: string): Promise<InstallOutcome> => {
    const name = await promptModName(defaultModNameForFolder(folder), validateName);
    if (!name) return NOT_INSTALLED;
    let succeeded = false;
    await runWriting(() => runModAction('installFromFolder', `Failed to install "${name}".`, async () => {
      const outcome = await installFromFolder(access, { kind: 'new', name }, folder, { gameName: instance.value.gameName });
      if (!outcome.applied) throw new Error(outcome.refusal);
      warnIfFomod(name, outcome.isFomod);
      succeeded = true;
    }));
    return { installed: succeeded };
  };
  return [
    vscode.commands.registerCommand('modbench.mod.install', async (source?: unknown): Promise<InstallOutcome> => {
      if (isDownloadedFile(source)) return { installed: await installDownloaded(source.row) };
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
