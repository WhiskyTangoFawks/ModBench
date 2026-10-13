// The install gesture: a downloaded file handed as the Argument, or an archive or a folder the user picks.

import * as vscode from 'vscode';
import type { DownloadFile, Instance } from '../instanceLoader/instance';
import { ARCHIVE_EXTENSIONS, defaultModName, defaultModNameForFolder, samePath } from '../instanceAdapter/instanceAdapter';
import type { ModlistCommands, ModSource } from '../modOrderCommands/modOrderCommands';
import { downloadArgumentOf } from '../drivingLib/argument';
import { promptModName } from './promptModName';
import { reportFailure } from '../drivingLib/reportFailure';
import type { Reporter } from '../ports/reporter';
import { runModsWriting } from './gestureEntry';
import { downloadedFileSource, installDownloadedFile, logUnmarked, type DownloadInstallDeps } from './installDownloaded';

interface InstallOutcome {
  installed: boolean;
}
const NOT_INSTALLED: InstallOutcome = { installed: false };

interface ModInstallDeps {
  commands: Pick<ModlistCommands, 'installMod' | 'newModNameRefusal'>;
  instance: Pick<Instance, 'value' | 'refresh'>;
  reporterFor: (tag: string) => Reporter;
  warnIfFomod: (name: string, isFomod: boolean) => void;
  downloadInstall: Pick<DownloadInstallDeps, 'reporter' | 'log' | 'progressViewId'>;
}

interface SourceKindItem extends vscode.QuickPickItem {
  sourceKind: 'archive' | 'folder';
}

// modbench.mod.install: with no source, as from the Mods menu, it asks archive-or-folder first,
// before either OS picker opens (mods.md, Create empty mod and install, story 2).
export function registerModInstallCommands(deps: ModInstallDeps): vscode.Disposable[] {
  const { commands, instance, reporterFor, warnIfFomod, downloadInstall } = deps;
  const downloadedFileAt = (path: string): DownloadFile | undefined => {
    const { downloads } = instance.value;
    return downloads.kind === 'listed' ? downloads.rows.find((row) => samePath(row.path, path)) : undefined;
  };
  const installNew = async (source: ModSource, defaultName: string, tag: string): Promise<InstallOutcome> => {
    const name = await promptModName(defaultName, (value) => commands.newModNameRefusal(instance.value, value));
    if (!name) return NOT_INSTALLED;
    let succeeded = false;
    await runModsWriting(instance, () => reportFailure(reporterFor(tag), `Failed to install "${name}".`, async () => {
      const outcome = await commands.installMod(source, { kind: 'new', name }, instance.value.gameName);
      if (!outcome.applied) throw new Error(outcome.refusal);
      warnIfFomod(name, outcome.isFomod);
      if (source.kind === 'downloadedFile') logUnmarked(downloadInstall.log, source.name, outcome.downloadRefusal);
      succeeded = true;
    }));
    return { installed: succeeded };
  };
  // An archive that is one of the instance's downloaded files installs as that file, so the
  // mod manager's own Downloads view sees it installed.
  const installArchive = (archive: string): Promise<InstallOutcome> => {
    const downloaded = downloadedFileAt(archive);
    return installNew(downloaded ? downloadedFileSource(downloaded) : { kind: 'archive', path: archive }, defaultModName(archive), 'installFromArchive');
  };
  return [
    vscode.commands.registerCommand('modbench.mod.install', async (argument?: unknown): Promise<InstallOutcome> => {
      const download = downloadArgumentOf(argument);
      if (download) {
        const installed = await installDownloadedFile(
          download, commands, instance, { ...downloadInstall, warnIfFomod });
        return { installed };
      }
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
      return folder ? installNew({ kind: 'folder', path: folder }, defaultModNameForFolder(folder), 'installFromFolder') : NOT_INSTALLED;
    }),
  ];
}
