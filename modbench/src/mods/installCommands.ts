import * as vscode from 'vscode';
import type { DownloadFile, Instance, InstanceValue } from '../instanceLoader/instance';
import { ARCHIVE_EXTENSIONS, defaultModName, defaultModNameForFolder, samePath } from '../instanceAdapter/instanceAdapter';
import type { InstallTarget, ModlistCommands, ModSource } from '../modOrderCommands/modOrderCommands';
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
import { upgradeLoss, type ReadStatus } from './modStatuses';
import { failureReason, isReadFailed } from '../wire/readFailed';

interface InstalledMod {
  readonly name: string;
  readonly isFomod: boolean;
}

type InstallResult = GestureResult<InstalledMod>;

type InstallVia = 'downloadedFile' | 'installFromArchive' | 'installFromFolder';

interface Install {
  readonly source: ModSource;
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
  commands: Pick<ModlistCommands, 'installMod' | 'newModNameRefusal'>;
  readStatus: ReadStatus;
  instance: Pick<Instance, 'value' | 'refresh'>;
  reporterFor: (tag: string) => Reporter;
  warnIfFomod: (name: string, isFomod: boolean) => void;
  downloadInstall: { reporter: Reporter; log: (line: string) => void; progressViewId: string };
}

interface SourceKindItem extends vscode.QuickPickItem {
  sourceKind: 'archive' | 'folder';
}

const downloadedFileSource = ({ name, path, modID, fileID, version }: DownloadFile): ModSource =>
  ({ kind: 'downloadedFile', name, path, modID, fileID, version });

const unmarked = (source: ModSource, downloadRefusal: string | undefined): PartialFailure[] =>
  source.kind === 'downloadedFile' && downloadRefusal !== undefined
    ? [{ message: `"${source.name}" was installed, but its Downloads status could not be updated`, detail: downloadRefusal, severity: 'log' }]
    : [];

type Downloads = InstanceValue['downloads'];

// An archive that is one of the instance's downloaded files installs as that file, so the
// mod manager's own Downloads view sees it installed.
const archiveSource = (downloads: Downloads, path: string): ModSource => {
  const downloaded = downloads.kind === 'listed' ? downloads.rows.find((row) => samePath(row.path, path)) : undefined;
  return downloaded ? downloadedFileSource(downloaded) : { kind: 'archive', path };
};

const sourceOf = (downloads: Downloads, argument: readonly Argument[]): Pick<Install, 'source' | 'via'> => {
  const [only, ...more] = argument;
  if (only === undefined || more.length > 0) throw new Refusal('An agent call to install carries one source: a downloaded file, an archive or a folder.');
  const given = argumentOfKind(only, 'downloadedFile', 'archive', 'folder');
  if (given.kind === 'downloadedFile') return { source: downloadedFileSource(downloadedFileNamed(downloads, given.name)), via: 'downloadedFile' };
  return given.kind === 'archive'
    ? { source: archiveSource(downloads, given.path), via: 'installFromArchive' }
    : { source: { kind: 'folder', path: given.path }, via: 'installFromFolder' };
};

const targetOf = ({ name, target }: InstallOptions, newModNameRefusal: (name: string) => string | undefined): InstallTarget => {
  if (name !== undefined && target === undefined) {
    const refusal = newModNameRefusal(name);
    if (refusal !== undefined) throw new Refusal(refusal);
    return { kind: 'new', name };
  }
  if (target !== undefined && name === undefined) return { kind: 'upgrade', name: target };
  throw new Refusal('An agent call to install carries the name of a new mod, or the target mod to upgrade, and not both.');
};

async function pickSourcePath(): Promise<{ kind: 'archive' | 'folder'; path: string } | undefined> {
  const picked = await vscode.window.showQuickPick<SourceKindItem>(
    [
      { label: 'Archive…', description: 'A .zip, .7z or .rar file', sourceKind: 'archive' },
      { label: 'Folder…', description: 'An already-extracted mod folder', sourceKind: 'folder' },
    ],
    { placeHolder: 'Install a mod from an archive or a folder' },
  );
  if (!picked) return undefined;
  const dialog = picked.sourceKind === 'archive'
    ? { canSelectMany: false, filters: { 'Mod archives': [...ARCHIVE_EXTENSIONS] }, openLabel: 'Install' }
    : { canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Install' };
  const path = (await vscode.window.showOpenDialog(dialog))?.[0]?.fsPath;
  return path ? { kind: picked.sourceKind, path } : undefined;
}

// modbench.mod.install: with no source, as from the Mods menu, it asks archive-or-folder first,
// before either OS picker opens (mods.md, Create empty mod and install, story 2).
export function registerModInstallCommands(deps: ModInstallDeps): vscode.Disposable[] {
  const { commands, instance, reporterFor, warnIfFomod, downloadInstall, readStatus } = deps;
  const reporterOf = (via: InstallVia): Reporter => (via === 'downloadedFile' ? downloadInstall.reporter : reporterFor(via));
  const newModNameRefusal = (name: string) => commands.newModNameRefusal(instance.value, name);
  const failedMessage = ({ source, target, via }: Install): string =>
    `Failed to install "${source.kind === 'downloadedFile' && via === 'downloadedFile' ? source.name : target.name}".`;

  const upgradeRefusal = async ({ target, force }: Install): Promise<string | undefined> => {
    if (force || target.kind !== 'upgrade') return undefined;
    const answer = await readStatus([target.name]);
    if (isReadFailed(answer)) return `"${target.name}" status could not be read: ${failureReason(answer)}`;
    const status = answer.find(({ mod }) => mod === target.name);
    if (status === undefined) return `"${target.name}" has no status to read.`;
    if (status.unreadable) return `"${target.name}" status could not be read: ${status.unreadable.why}`;
    const loss = upgradeLoss(status);
    return loss === undefined ? undefined : `The upgrade would lose, in "${target.name}": ${loss}. Request it again with force to replace them.`;
  };

  const installedMod = async (install: Install): Promise<InstallResult> => {
    try {
      const refusal = await upgradeRefusal(install);
      if (refusal !== undefined) return { applied: false, refusal: failedMessage(install), detail: refusal };
      const outcome = await commands.installMod(install.source, install.target, instance.value.gameName);
      if (!outcome.applied) return { applied: false, refusal: failedMessage(install), detail: outcome.refusal };
      return {
        applied: true,
        outcome: { landed: [{ name: install.target.name, isFomod: outcome.isFomod }], refused: [] },
        partial: unmarked(install.source, outcome.downloadRefusal),
      };
    } catch (err) {
      return { applied: false, refusal: failedMessage(install), detail: errorMessage(err) };
    }
  };

  const newMod = async (source: ModSource, defaultName: string, via: InstallVia): Promise<Install | undefined> => {
    const name = await promptModName(defaultName, newModNameRefusal);
    return name ? { source, target: { kind: 'new', name }, via, force: true } : undefined;
  };

  const pickedSource = async (): Promise<Install | undefined> => {
    const picked = await pickSourcePath();
    if (!picked) return undefined;
    return picked.kind === 'archive'
      ? newMod(archiveSource(instance.value.downloads, picked.path), defaultModName(picked.path), 'installFromArchive')
      : newMod({ kind: 'folder', path: picked.path }, defaultModNameForFolder(picked.path), 'installFromFolder');
  };

  const downloadedFileInstall = async (name: string): Promise<Install | undefined> => {
    const row = downloadedFileNamed(instance.value.downloads, name);
    const target = await chooseInstallTarget(row, (defaultName) => promptModName(defaultName, newModNameRefusal));
    return target ? { source: downloadedFileSource(row), target, via: 'downloadedFile', force: true } : undefined;
  };

  const gesture: AgentGesture<KindedRow, Install, InstallResult, InstallOptions> = {
    fromView: async (_entry, _option, clicked) => {
      const download = downloadArgumentOf(clicked);
      if (!download) return pickedSource();
      try {
        return await downloadedFileInstall(download.row.name);
      } catch (err) {
        downloadInstall.reporter.report('error', `Failed to install "${download.row.name}".`, errorMessage(err));
        return undefined;
      }
    },
    fromAgent: ({ argument, options }) =>
      ({ ...sourceOf(instance.value.downloads, argument), target: targetOf(options, newModNameRefusal), force: options.force === true }),
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
