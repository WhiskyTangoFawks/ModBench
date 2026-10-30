import type { ManifestStep } from '../manifestAdapter/manifestAdapter';
import type { StepTasks } from '../sourceCommands/steps';

interface StepsRun { readonly steps: readonly ManifestStep[]; readonly folder: string }

/** A machine whose user tasks are those labelled: each folder's steps are recorded, and fail as `failures` says by
 *  folder, or exit with code 0. */
export function recordingTasks(
  labels: readonly string[] = [], failures: Readonly<Record<string, string>> = {},
): StepTasks & { readonly runs: StepsRun[] } {
  const runs: StepsRun[] = [];
  return {
    runs,
    labels: () => Promise.resolve(labels),
    whyStepsFailed: (steps, folder) => {
      runs.push({ steps, folder });
      return Promise.resolve(failures[folder]);
    },
  };
}
