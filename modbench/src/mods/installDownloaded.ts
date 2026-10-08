import type { Instance } from '../instanceLoader/instance';
import { installFromArchive, installNameRefusal, type InstallAccess } from '../install/install';
import { chooseInstallTarget } from './installTarget';
import { promptModName } from '../drivingLib/promptModName';
import { runWritingGesture } from '../drivingLib/writingGesture';
import { errorMessage } from '../ports/errorMessage';
import type { DownloadArgument } from '../drivingLib/argument';
import type { Reporter } from '../ports/reporter';

export interface DownloadInstallDeps {
  warnIfFomod: (name: string, isFomod: boolean) => void;
  /** Install's failed-mark line: an Output line, no notification. */
  log: (line: string) => void;
  /** The view whose progress bar the install runs under: the one the row was clicked in. */
  progressView: string;
}

// The row holds the archive's path and its own mod id, file id and version, so install re-reads
// no sidecar; install marks the download installed.
export async function installDownloadedFile(
  argument: DownloadArgument, access: InstallAccess, instance: Pick<Instance, 'value' | 'refresh'>, reporter: Reporter,
  deps: DownloadInstallDeps,
): Promise<boolean> {
  const { row } = argument;
  const { name } = row;
  let downloadRefusal: string | undefined;
  try {
    const target = await chooseInstallTarget(
      argument, (defaultName) => promptModName(defaultName, (name) => installNameRefusal(access, name)));
    if (!target) return false;
    const outcome = await runWritingGesture(deps.progressView, instance, () => installFromArchive(access, target, row.path, {
      gameName: instance.value.gameName, modID: row.modID, fileID: row.fileID, version: row.version,
    }));
    if (!outcome.applied) {
      reporter.report('error', `Failed to install "${name}".`, outcome.refusal);
      return false;
    }
    deps.warnIfFomod(target.name, outcome.isFomod);
    downloadRefusal = outcome.downloadRefusal;
  } catch (err) {
    // ADR-0019.
    reporter.report('error', `Failed to install "${name}".`, errorMessage(err));
    return false;
  }
  if (downloadRefusal === undefined) return true;
  // downloads.md, Reporting story 1: the install landed, so it is not reported as failed — the
  // row still shows Installed, straight off meta.ini, and the failed mark is one Output line.
  deps.log(`"${name}" was installed, but its Downloads status could not be updated: ${downloadRefusal}`);
  return true;
}
