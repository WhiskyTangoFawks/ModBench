import type { Tasks } from '../ports/tasks';

interface TaskRun { readonly label: string; readonly args: readonly string[]; readonly folder: string }

/** The tasks port, second adapter: this machine has the tasks labelled, each run exits with the code or reason given
 *  for its label, 0 by default, and each run is recorded in order. */
export function recordingTasks(labels: readonly string[] = [], ends: Readonly<Record<string, number | string>> = {}): Tasks & { readonly runs: TaskRun[] } {
  const runs: TaskRun[] = [];
  return {
    runs,
    labels: () => Promise.resolve(labels),
    run: (label, args, folder) => {
      runs.push({ label, args, folder });
      return Promise.resolve(ends[label] ?? 0);
    },
  };
}
