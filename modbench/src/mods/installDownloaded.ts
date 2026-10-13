import type { DownloadFile, Instance } from '../instanceLoader/instance';
import type { ModlistCommands, ModSource } from '../modOrderCommands/modOrderCommands';
import { chooseInstallTarget } from './installTarget';
import { promptModName } from './promptModName';
import { reportFailure } from '../drivingLib/reportFailure';
import { runWritingGesture } from '../drivingLib/writingGesture';
import type { DownloadArgument } from '../drivingLib/argument';
import type { Reporter } from '../ports/reporter';

/** A downloaded file of the instance value as install takes it. */
export const downloadedFileSource = ({ name, path, modID, fileID, version }: DownloadFile): ModSource =>
  ({ kind: 'downloadedFile', name, path, modID, fileID, version });

/** downloads.md, Reporting story 1: an install that landed is not reported as failed, so a
 *  downloaded file it could not mark installed is one Output line. */
export function logUnmarked(log: (line: string) => void, name: string, downloadRefusal: string | undefined): void {
  if (downloadRefusal !== undefined) log(`"${name}" was installed, but its Downloads status could not be updated: ${downloadRefusal}`);
}

export interface DownloadInstallDeps {
  reporter: Reporter;
  warnIfFomod: (name: string, isFomod: boolean) => void;
  log: (line: string) => void;
  progressViewId: string;
}

export async function installDownloadedFile(
  argument: DownloadArgument, commands: Pick<ModlistCommands, 'installMod' | 'newModNameRefusal'>, instance: Pick<Instance, 'value' | 'refresh'>, deps: DownloadInstallDeps,
): Promise<boolean> {
  let installed = false;
  let downloadRefusal: string | undefined;
  await reportFailure(deps.reporter, `Failed to install "${argument.row.name}".`, async () => {
    const { downloads } = instance.value;
    const row = downloads.kind === 'listed' ? downloads.rows.find((listed) => listed.name === argument.row.name) : undefined;
    if (!row) throw new Error(`"${argument.row.name}" is gone from Downloads.`);
    const target = await chooseInstallTarget(
      row, (defaultName) => promptModName(defaultName, (name) => commands.newModNameRefusal(name)));
    if (!target) return;
    const outcome = await runWritingGesture(deps.progressViewId, instance, () => commands.installMod(
      downloadedFileSource(row), target, instance.value.gameName));
    if (!outcome.applied) throw new Error(outcome.refusal);
    deps.warnIfFomod(target.name, outcome.isFomod);
    downloadRefusal = outcome.downloadRefusal;
    installed = true;
  });
  logUnmarked(deps.log, argument.row.name, downloadRefusal);
  return installed;
}
