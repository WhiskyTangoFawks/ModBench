// The install gesture: a downloaded file, an archive or a folder, as a new mod or over an installed one.

import * as vscode from 'vscode';
import type { DownloadFile, Instance } from '../instanceLoader/instance';
import { ARCHIVE_EXTENSIONS, defaultModName, defaultModNameForFolder, samePath } from '../instanceAdapter/instanceAdapter';
import type { InstallTarget, ModlistCommands, ModSource } from '../modOrderCommands/modOrderCommands';
import { downloadArgumentOf } from '../drivingLib/argument';
import {
  argumentOfKind, registerAgentGesture, reportPartial, type AgentCall, type AgentGesture, type GestureResult, type PartialFailure,
} from '../drivingLib/agentGesture';
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

// Decides the reporter an install's failure goes to, and the view that shows its progress.
type InstallVia = 'downloadedFile' | 'installFromArchive' | 'installFromFolder';

interface Install {
  readonly source: ModSource;
  readonly target: InstallTarget;
  readonly via: InstallVia;
}

interface InstallOptions {
  readonly name?: string;
  readonly target?: string;
}

interface ModInstallDeps {
  commands: Pick<ModlistCommands, 'installMod' | 'newModNameRefusal'>;
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

// modbench.mod.install: with no source, as from the Mods menu, it asks archive-or-folder first,
// before either OS picker opens (mods.md, Create empty mod and install, story 2).
export function registerModInstallCommands(deps: ModInstallDeps): vscode.Disposable[] {
  const { commands, instance, reporterFor, warnIfFomod, downloadInstall } = deps;
  const downloadedFileNamed = (name: string): DownloadFile => {
    const { downloads } = instance.value;
    const row = downloads.kind === 'listed' ? downloads.rows.find((listed) => listed.name === name) : undefined;
    if (!row) throw new Refusal(`"${name}" is gone from Downloads.`);
    return row;
  };
  // An archive that is one of the instance's downloaded files installs as that file, so the
  // mod manager's own Downloads view sees it installed.
  const archiveSource = (path: string): ModSource => {
    const { downloads } = instance.value;
    const downloaded = downloads.kind === 'listed' ? downloads.rows.find((row) => samePath(row.path, path)) : undefined;
    return downloaded ? downloadedFileSource(downloaded) : { kind: 'archive', path };
  };
  const reporterOf = (via: InstallVia): Reporter => (via === 'downloadedFile' ? downloadInstall.reporter : reporterFor(via));
  const failedMessage = ({ source, target, via }: Install): string =>
    `Failed to install "${source.kind === 'downloadedFile' && via === 'downloadedFile' ? source.name : target.name}".`;

  const installedMod = async (install: Install): Promise<InstallResult> => {
    try {
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
    const name = await promptModName(defaultName, (value) => commands.newModNameRefusal(instance.value, value));
    return name ? { source, target: { kind: 'new', name }, via } : undefined;
  };

  const pickedSource = async (): Promise<Install | undefined> => {
    const picked = await vscode.window.showQuickPick<SourceKindItem>(
      [
        { label: 'Archive…', description: 'A .zip, .7z or .rar file', sourceKind: 'archive' },
        { label: 'Folder…', description: 'An already-extracted mod folder', sourceKind: 'folder' },
      ],
      { placeHolder: 'Install a mod from an archive or a folder' },
    );
    if (!picked) return undefined;
    if (picked.sourceKind === 'archive') {
      const archivePicked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'Mod archives': [...ARCHIVE_EXTENSIONS] },
        openLabel: 'Install',
      });
      const archive = archivePicked?.[0]?.fsPath;
      return archive ? newMod(archiveSource(archive), defaultModName(archive), 'installFromArchive') : undefined;
    }
    const folderPicked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Install',
    });
    const folder = folderPicked?.[0]?.fsPath;
    return folder ? newMod({ kind: 'folder', path: folder }, defaultModNameForFolder(folder), 'installFromFolder') : undefined;
  };

  const downloadedFileInstall = async (name: string): Promise<Install | undefined> => {
    const row = downloadedFileNamed(name);
    const target = await chooseInstallTarget(
      row, (defaultName) => promptModName(defaultName, (value) => commands.newModNameRefusal(instance.value, value)));
    return target ? { source: downloadedFileSource(row), target, via: 'downloadedFile' } : undefined;
  };

  const targetOf = ({ name, target }: InstallOptions): InstallTarget => {
    if (name !== undefined && target === undefined) {
      const refusal = commands.newModNameRefusal(instance.value, name);
      if (refusal !== undefined) throw new Refusal(refusal);
      return { kind: 'new', name };
    }
    if (target !== undefined && name === undefined) return { kind: 'upgrade', name: target };
    throw new Refusal('An agent call to install carries the name of a new mod, or the target mod to upgrade, and not both.');
  };

  const sourceOf = ({ argument }: AgentCall<InstallOptions>): Pick<Install, 'source' | 'via'> => {
    const [only, ...more] = argument;
    if (only === undefined || more.length > 0) throw new Refusal('An agent call to install carries one source: a downloaded file, an archive or a folder.');
    const given = argumentOfKind(only, 'downloadedFile', 'archive', 'folder');
    if (given.kind === 'downloadedFile') return { source: downloadedFileSource(downloadedFileNamed(given.name)), via: 'downloadedFile' };
    return given.kind === 'archive'
      ? { source: archiveSource(given.path), via: 'installFromArchive' }
      : { source: { kind: 'folder', path: given.path }, via: 'installFromFolder' };
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
    fromAgent: (call) => ({ ...sourceOf(call), target: targetOf(call.options) }),
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
