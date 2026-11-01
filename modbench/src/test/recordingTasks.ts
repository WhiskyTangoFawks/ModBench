import type { RunStep } from '../manifestAdapter/manifestAdapter';
import type { StepTasks } from '../sourceCommands/steps';

interface StepRun { readonly step: RunStep; readonly folder: string }

/** A machine whose user tasks are those labelled: each step run is recorded, and fails as `failures` says by folder, or
 *  exits with code 0. */
export function recordingTasks(
  labels: readonly string[] = [], failures: Readonly<Record<string, string>> = {},
): StepTasks & { readonly runs: StepRun[] } {
  const runs: StepRun[] = [];
  return {
    runs,
    labels: () => Promise.resolve(labels),
    whyStepFailed: (step, { folder }) => {
      runs.push({ step, folder });
      return Promise.resolve(failures[folder]);
    },
  };
}
