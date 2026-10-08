import type { Instance } from '../instanceLoader/instance';
import { installFromArchive, installNameRefusal, type InstallAccess } from '../install/install';
import { chooseInstallTarget } from './installTarget';
import { promptModName } from './promptModName';
import { reportFailure } from '../drivingLib/reportFailure';
import { runWritingGesture } from '../drivingLib/writingGesture';
import type { DownloadArgument } from '../drivingLib/argument';
import type { Reporter } from '../ports/reporter';

export interface DownloadInstallDeps {
  reporter: Reporter;
  warnIfFomod: (name: string, isFomod: boolean) => void;
  log: (line: string) => void;
  progressViewId: string;
}

export async function installDownloadedFile(
  argument: DownloadArgument, access: InstallAccess, instance: Pick<Instance, 'value' | 'refresh'>, deps: DownloadInstallDeps,
): Promise<boolean> {
  let installed = false;
  let downloadRefusal: string | undefined;
  await reportFailure(deps.reporter, `Failed to install "${argument.row.name}".`, async () => {
    const { downloads } = instance.value;
    const row = downloads.kind === 'listed' ? downloads.rows.find((listed) => listed.name === argument.row.name) : undefined;
    if (!row) throw new Error(`"${argument.row.name}" is gone from Downloads.`);
    const target = await chooseInstallTarget(
      row, (defaultName) => promptModName(defaultName, (name) => installNameRefusal(access.adapter, name)));
    if (!target) return;
    const outcome = await runWritingGesture(deps.progressViewId, instance, () => installFromArchive(access, target, row.path, {
      gameName: instance.value.gameName, modID: row.modID, fileID: row.fileID, version: row.version,
    }));
    if (!outcome.applied) throw new Error(outcome.refusal);
    deps.warnIfFomod(target.name, outcome.isFomod);
    downloadRefusal = outcome.downloadRefusal;
    installed = true;
  });
  // downloads.md, Reporting story 1: the install landed, so it is not reported as failed — the
  // row still shows Installed, straight off meta.ini, and the failed mark is one Output line.
  if (downloadRefusal !== undefined) {
    deps.log(`"${argument.row.name}" was installed, but its Downloads status could not be updated: ${downloadRefusal}`);
  }
  return installed;
}
