import * as vscode from 'vscode';
import type { LocatedDownloadedFileRow, Instance } from '../instanceLoader/instance';
import { INSTALLATION_FILE_EXTENSIONS } from '../instanceAdapter/instanceAdapter';
import type { FomodAnswer, FomodLanded, FomodStepChoice, InstallTarget, ModCommands, ModPackage } from '../modCommands/modCommands';
import { downloadedFileArgumentOf, downloadedFileNamed } from '../drivingLib/argument';
import {
  argumentOfKind, registerAgentGesture, reportPartial, type AgentGesture, type GestureResult, type PartialFailure,
} from '../drivingLib/agentGesture';
import type { AskQuestion } from '../ports/dialog';
import type { Argument } from '../wire/argument';
import type { KindedRow } from '../drivingLib/gestureEntry';
import { Refusal } from '../drivingLib/refusal';
import { errorMessage } from '../ports/errorMessage';
import { chooseInstallTarget, defaultModName } from './installTarget';
import { promptModName } from './promptModName';
import { promptRefusal, refuseAgentName } from './nameRefusals';
import { runWritingGesture } from '../drivingLib/writingGesture';
import type { Reporter } from '../ports/reporter';
import { MODS_KEY_ARGS } from './gestureEntry';

interface InstalledMod {
  readonly name: string;
  readonly fomod?: FomodLanded;
}

type InstallResult = GestureResult<InstalledMod>;

type InstallVia = 'downloadedFile' | 'installFromInstallationFile' | 'installFromFolder';

interface Install {
  readonly package: ModPackage;
  readonly target: InstallTarget;
  readonly via: InstallVia;
  readonly force: boolean;
  readonly fomod?: FomodAnswer;
}

interface InstallOptions {
  readonly name?: string;
  readonly target?: string;
  readonly force?: boolean;
  readonly choices?: readonly FomodStepChoice[];
  readonly manual?: boolean;
}

interface ModInstallDeps {
  commands: Pick<ModCommands, 'installMod' | 'newModNameRefusal' | 'upgradeLoss' | 'names'>;
  instance: Pick<Instance, 'value' | 'refresh'>;
  reporterFor: (tag: string) => Reporter;
  ask: AskQuestion;
  downloadedFileInstallReporting: { reporter: Reporter; log: (line: string) => void; progressViewId: string };
}

interface PackageKindItem extends vscode.QuickPickItem {
  packageKind: 'archive' | 'folder';
}

const UPGRADE = 'Upgrade';

const downloadedFilePackage = ({ name }: LocatedDownloadedFileRow): ModPackage => ({ kind: 'downloadedFile', name });

const unmarked = (downloadedFile: string | undefined, downloadedFileRefusal: string | undefined): PartialFailure[] =>
  downloadedFile !== undefined && downloadedFileRefusal !== undefined
    ? [{ message: `"${downloadedFile}" was installed, but its Downloads status could not be updated`, detail: downloadedFileRefusal, severity: 'log' }]
    : [];

const unlined = (mod: string, modOrderFile: string, lineRefusal: string | undefined): PartialFailure[] =>
  (lineRefusal === undefined ? [] : [{ message: `"${mod}" was installed, but its ${modOrderFile} line could not be written`, detail: lineRefusal, severity: 'warning' }]);

// A FOMOD that landed as a plain copy, or without some of its files, warns a view and writes the agent's Output line.
const fomodPartial = (mod: string, fomod: FomodLanded | undefined): PartialFailure[] => {
  if (fomod === undefined) return [];
  if (fomod.kind === 'plainCopy') {
    return [{ message: `"${mod}" is a FOMOD installed as a plain copy: its files need arranging by hand, because its installer's own steps did not run:`, detail: `${fomod.why}.`, severity: 'warning' }];
  }
  return [
    ...(fomod.missing.length === 0 ? [] : [{ message: `"${mod}" lacks files its FOMOD names and its archive does not hold:`, detail: fomod.missing.join(', '), severity: 'warning' as const }]),
    ...fomod.notes.map((note) => ({ message: `"${mod}": its FOMOD's installer says`, detail: note, severity: 'warning' as const })),
  ];
};

const packageOf = (argument: readonly Argument[]): Pick<Install, 'package' | 'via'> => {
  const [only, ...more] = argument;
  if (only === undefined || more.length > 0) throw new Refusal('An agent call to install carries one package: a downloaded file, an archive or a folder.');
  const given = argumentOfKind(only, 'downloadedFile', 'archive', 'folder');
  if (given.kind === 'downloadedFile') return { package: { kind: 'downloadedFile', name: given.name }, via: 'downloadedFile' };
  return given.kind === 'archive'
    ? { package: { kind: 'archive', path: given.path }, via: 'installFromInstallationFile' }
    : { package: { kind: 'folder', path: given.path }, via: 'installFromFolder' };
};

const targetOf = async (
  { name, target }: InstallOptions, newModNameRefusal: (name: string) => Promise<string | undefined>,
): Promise<InstallTarget> => {
  if (name !== undefined && target === undefined) {
    await refuseAgentName(newModNameRefusal(name));
    return { kind: 'new', name };
  }
  if (target !== undefined && name === undefined) return { kind: 'upgrade', name: target };
  throw new Refusal('An agent call to install carries exactly one of the name of a new mod and the target mod to upgrade.');
};

// No choices answer a FOMOD with none, so a FOMOD with a step to answer is refused, listing it.
const fomodAnswerOf = ({ choices, manual }: InstallOptions): FomodAnswer => {
  if (manual !== true) return { kind: 'choices', steps: choices ?? [] };
  if (choices !== undefined) throw new Refusal('An agent call to install carries choices or manual, not both.');
  return { kind: 'manual' };
};

async function pickPackage(): Promise<{ kind: 'archive' | 'folder'; path: string; name: string } | undefined> {
  const picked = await vscode.window.showQuickPick<PackageKindItem>(
    [
      { label: 'Archive…', description: 'A .zip, .7z or .rar file', packageKind: 'archive' },
      { label: 'Folder…', description: 'An already-extracted mod folder', packageKind: 'folder' },
    ],
    { placeHolder: 'Install a mod from an archive or a folder' },
  );
  if (!picked) return undefined;
  const dialog = picked.packageKind === 'archive'
    ? { canSelectMany: false, filters: { 'Mod archives': [...INSTALLATION_FILE_EXTENSIONS] }, openLabel: 'Install' }
    : { canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Install' };
  const uri = (await vscode.window.showOpenDialog(dialog))?.[0];
  // A Uri's path is '/'-separated on every platform.
  return uri ? { kind: picked.packageKind, path: uri.fsPath, name: uri.path.slice(uri.path.lastIndexOf('/') + 1) } : undefined;
}

// modbench.mod.install: with no package, as from the Mods menu, it asks installation-file-or-folder first,
// before either OS picker opens (mods.md, Create empty mod and install, story 2).
export function registerModInstallCommands(deps: ModInstallDeps): vscode.Disposable[] {
  const { commands, instance, reporterFor, ask, downloadedFileInstallReporting } = deps;
  const reporterOf = (via: InstallVia): Reporter => (via === 'downloadedFile' ? downloadedFileInstallReporting.reporter : reporterFor(via));
  const newModNameRefusal = (name: string) => promptRefusal(commands.newModNameRefusal(name));
  const failedMessage = ({ package: installed, target, via }: Install): string =>
    `Failed to install "${installed.kind === 'downloadedFile' && via === 'downloadedFile' ? installed.name : target.name}".`;

  const installedMod = async (install: Install): Promise<InstallResult> => {
    try {
      const outcome = await commands.installMod(install.package, install.target, install.force, install.fomod);
      if (!outcome.applied) return { applied: false, refusal: failedMessage(install), detail: outcome.refusal };
      return {
        applied: true,
        outcome: { landed: [{ name: install.target.name, ...(outcome.fomod && { fomod: outcome.fomod }) }], refused: [] },
        partial: [
          ...unlined(install.target.name, commands.names.modOrderFile, outcome.lineRefusal),
          ...unmarked(outcome.downloadedFile, outcome.downloadedFileRefusal),
          ...fomodPartial(install.target.name, outcome.fomod),
        ],
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
    const picked = await pickPackage();
    if (!picked) return undefined;
    return picked.kind === 'archive'
      ? newMod({ kind: 'archive', path: picked.path }, defaultModName(picked.name), 'installFromInstallationFile')
      : newMod({ kind: 'folder', path: picked.path }, picked.name, 'installFromFolder');
  };

  const upgradeConfirmed = async (target: InstallTarget): Promise<boolean> => {
    const loss = await commands.upgradeLoss(target);
    return loss === undefined || await ask(`Upgrade "${target.name}"?`, { modal: true, detail: loss }, UPGRADE) === UPGRADE;
  };

  const downloadedFileInstall = async (name: string): Promise<Install | undefined> => {
    const row = downloadedFileNamed(instance.value.downloadedFiles, name);
    const target = await chooseInstallTarget(row, (defaultName) => promptModName(defaultName, newModNameRefusal));
    if (!target || !(await upgradeConfirmed(target))) return undefined;
    return { package: downloadedFilePackage(row), target, via: 'downloadedFile', force: true };
  };

  const gesture: AgentGesture<KindedRow, Install, InstallResult, InstallOptions> = {
    fromView: async (_entry, _option, clicked) => {
      const downloadedFile = downloadedFileArgumentOf(clicked);
      if (!downloadedFile) return pickedPackage();
      try {
        return await downloadedFileInstall(downloadedFile.row.name);
      } catch (err) {
        downloadedFileInstallReporting.reporter.report('error', `Failed to install "${downloadedFile.row.name}".`, errorMessage(err));
        return undefined;
      }
    },
    fromAgent: async ({ argument, options }) => ({
      ...packageOf(argument), target: await targetOf(options, (name) => commands.newModNameRefusal(name)), force: options.force === true,
      fomod: fomodAnswerOf(options),
    }),
    run: (install) => runWritingGesture(
      install.via === 'downloadedFile' ? downloadedFileInstallReporting.progressViewId : MODS_KEY_ARGS.view, instance, () => installedMod(install)),
    report: (result, install) => {
      if (!result.applied) {
        reporterOf(install.via).report('error', result.refusal, result.detail);
        return;
      }
      reportPartial(downloadedFileInstallReporting.reporter, result.partial, downloadedFileInstallReporting.log);
    },
  };
  return [registerAgentGesture('modbench.mod.install', () => [], gesture)];
}
