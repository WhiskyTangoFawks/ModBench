import * as vscode from 'vscode';
import type { DownloadFile, Instance, InstanceValue } from '../instanceLoader/instance';
import { ARCHIVE_EXTENSIONS, defaultModName, defaultModNameForFolder, samePath } from '../instanceAdapter/instanceAdapter';
import type { InstallTarget, ModCommands, ModPackage } from '../modCommands/modCommands';
import { downloadArgumentOf, downloadedFileNamed } from '../drivingLib/argument';
import {
  argumentOfKind, registerAgentGesture, reportPartial, type AgentGesture, type GestureResult, type PartialFailure,
} from '../drivingLib/agentGesture';
import type { Argument } from '../wire/argument';
import type { KindedRow } from '../drivingLib/gestureEntry';
import { Refusal } from '../drivingLib/refusal';
import { errorMessage } from '../ports/errorMessage';
import { chooseInstallTarget } from './installTarget';
import { promptModName } from './promptModName';
import { runWritingGesture } from '../drivingLib/writingGesture';
import type { Reporter } from '../ports/reporter';
import { MODS_KEY_ARGS } from './gestureEntry';

interface InstalledMod {
  readonly name: string;
  readonly isFomod: boolean;
}

type InstallResult = GestureResult<InstalledMod>;

type InstallVia = 'downloadedFile' | 'installFromArchive' | 'installFromFolder';

interface Install {
  readonly package: ModPackage;
  readonly target: InstallTarget;
  readonly via: InstallVia;
  readonly force: boolean;
}

interface InstallOptions {
  readonly name?: string;
  readonly target?: string;
  readonly force?: boolean;
}

interface ModInstallDeps {
  commands: Pick<ModCommands, 'installMod' | 'newModNameRefusal'>;
  instance: Pick<Instance, 'value' | 'refresh'>;
  reporterFor: (tag: string) => Reporter;
  warnIfFomod: (name: string, isFomod: boolean) => void;
  downloadInstall: { reporter: Reporter; log: (line: string) => void; progressViewId: string };
}

interface PackageKindItem extends vscode.QuickPickItem {
  packageKind: 'archive' | 'folder';
}

const downloadedFilePackage = ({ name, path, modID, fileID, version }: DownloadFile): ModPackage =>
  ({ kind: 'downloadedFile', name, path, modID, fileID, version });

const unmarked = (installed: ModPackage, downloadedFileRefusal: string | undefined): PartialFailure[] =>
  installed.kind === 'downloadedFile' && downloadedFileRefusal !== undefined
    ? [{ message: `"${installed.name}" was installed, but its Downloads status could not be updated`, detail: downloadedFileRefusal, severity: 'log' }]
    : [];

type Downloads = InstanceValue['downloads'];

// An archive that is one of the instance's downloaded files installs as that file, so the
// mod manager's own Downloads view sees it installed.
const archivePackage = (downloads: Downloads, path: string): ModPackage => {
  const downloaded = downloads.kind === 'listed' ? downloads.rows.find((row) => samePath(row.path, path)) : undefined;
  return downloaded ? downloadedFilePackage(downloaded) : { kind: 'archive', path };
};

const packageOf = (downloads: Downloads, argument: readonly Argument[]): Pick<Install, 'package' | 'via'> => {
  const [only, ...more] = argument;
  if (only === undefined || more.length > 0) throw new Refusal('An agent call to install carries one package: a downloaded file, an archive or a folder.');
  const given = argumentOfKind(only, 'downloadedFile', 'archive', 'folder');
  if (given.kind === 'downloadedFile') return { package: downloadedFilePackage(downloadedFileNamed(downloads, given.name)), via: 'downloadedFile' };
  return given.kind === 'archive'
    ? { package: archivePackage(downloads, given.path), via: 'installFromArchive' }
    : { package: { kind: 'folder', path: given.path }, via: 'installFromFolder' };
};

const targetOf = async (
  { name, target }: InstallOptions, newModNameRefusal: (name: string) => Promise<string | undefined>,
): Promise<InstallTarget> => {
  if (name !== undefined && target === undefined) {
    const refusal = await newModNameRefusal(name);
    if (refusal !== undefined) throw new Refusal(refusal);
    return { kind: 'new', name };
  }
  if (target !== undefined && name === undefined) return { kind: 'upgrade', name: target };
  throw new Refusal('An agent call to install carries the name of a new mod, or the target mod to upgrade, and not both.');
};

async function pickPackagePath(): Promise<{ kind: 'archive' | 'folder'; path: string } | undefined> {
  const picked = await vscode.window.showQuickPick<PackageKindItem>(
    [
      { label: 'Archive…', description: 'A .zip, .7z or .rar file', packageKind: 'archive' },
      { label: 'Folder…', description: 'An already-extracted mod folder', packageKind: 'folder' },
    ],
    { placeHolder: 'Install a mod from an archive or a folder' },
  );
  if (!picked) return undefined;
  const dialog = picked.packageKind === 'archive'
    ? { canSelectMany: false, filters: { 'Mod archives': [...ARCHIVE_EXTENSIONS] }, openLabel: 'Install' }
    : { canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Install' };
  const path = (await vscode.window.showOpenDialog(dialog))?.[0]?.fsPath;
  return path ? { kind: picked.packageKind, path } : undefined;
}

// modbench.mod.install: with no package, as from the Mods menu, it asks archive-or-folder first,
// before either OS picker opens (mods.md, Create empty mod and install, story 2).
export function registerModInstallCommands(deps: ModInstallDeps): vscode.Disposable[] {
  const { commands, instance, reporterFor, warnIfFomod, downloadInstall } = deps;
  const reporterOf = (via: InstallVia): Reporter => (via === 'downloadedFile' ? downloadInstall.reporter : reporterFor(via));
  const newModNameRefusal = (name: string) => commands.newModNameRefusal(name);
  const failedMessage = ({ package: installed, target, via }: Install): string =>
    `Failed to install "${installed.kind === 'downloadedFile' && via === 'downloadedFile' ? installed.name : target.name}".`;

  const installedMod = async (install: Install): Promise<InstallResult> => {
    try {
      const outcome = await commands.installMod(install.package, install.target, install.force);
      if (!outcome.applied) return { applied: false, refusal: failedMessage(install), detail: outcome.refusal };
      return {
        applied: true,
        outcome: { landed: [{ name: install.target.name, isFomod: outcome.isFomod }], refused: [] },
        partial: unmarked(install.package, outcome.downloadedFileRefusal),
      };
    } catch (err) {
      return { applied: false, refusal: failedMessage(install), detail: errorMessage(err) };
    }
  };

  const newMod = async (installed: ModPackage, defaultName: string, via: InstallVia): Promise<Install | undefined> => {
    const name = await promptModName(defaultName, newModNameRefusal);
    return name ? { package: installed, target: { kind: 'new', name }, via, force: true } : undefined;
  };

  const pickedPackage = async (): Promise<Install | undefined> => {
    const picked = await pickPackagePath();
    if (!picked) return undefined;
    return picked.kind === 'archive'
      ? newMod(archivePackage(instance.value.downloads, picked.path), defaultModName(picked.path), 'installFromArchive')
      : newMod({ kind: 'folder', path: picked.path }, defaultModNameForFolder(picked.path), 'installFromFolder');
  };

  const downloadedFileInstall = async (name: string): Promise<Install | undefined> => {
    const row = downloadedFileNamed(instance.value.downloads, name);
    const target = await chooseInstallTarget(row, (defaultName) => promptModName(defaultName, newModNameRefusal));
    return target ? { package: downloadedFilePackage(row), target, via: 'downloadedFile', force: true } : undefined;
  };

  const gesture: AgentGesture<KindedRow, Install, InstallResult, InstallOptions> = {
    fromView: async (_entry, _option, clicked) => {
      const download = downloadArgumentOf(clicked);
      if (!download) return pickedPackage();
      try {
        return await downloadedFileInstall(download.row.name);
      } catch (err) {
        downloadInstall.reporter.report('error', `Failed to install "${download.row.name}".`, errorMessage(err));
        return undefined;
      }
    },
    fromAgent: async ({ argument, options }) =>
      ({ ...packageOf(instance.value.downloads, argument), target: await targetOf(options, newModNameRefusal), force: options.force === true }),
    run: (install) => runWritingGesture(
      install.via === 'downloadedFile' ? downloadInstall.progressViewId : MODS_KEY_ARGS.view, instance, () => installedMod(install)),
    report: (result, install) => {
      if (!result.applied) {
        reporterOf(install.via).report('error', result.refusal, result.detail);
        return;
      }
      for (const { name, isFomod } of result.outcome.landed) warnIfFomod(name, isFomod);
      reportPartial(downloadInstall.reporter, result.partial, downloadInstall.log);
    },
  };
  return [registerAgentGesture('modbench.mod.install', () => [], gesture)];
}
