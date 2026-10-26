import type { ManifestStep } from '../client';
import { errorMessage } from '../ports/errorMessage';
import type { HostTasks } from '../ports/tasks';

/** A manifest's steps, each run as the VS Code user task its label names (mods.md, Build, story 14). */
export interface StepTasks {
  /** The label of each user task this machine has. */
  readonly labels: () => Promise<readonly string[]>;
  /** Runs each step in order in the folder the manifest builds, and answers why the first that did not exit with
   *  code 0 failed, or nothing when every step did. */
  readonly whyStepsFailed: (steps: readonly ManifestStep[], folder: string) => Promise<string | undefined>;
}

export function stepTasks<Task, P extends Task, S extends Task, Run>(host: HostTasks<Task, P, S, Run>): StepTasks {
  const userTasks = async (): Promise<Task[]> => (await host.fetch()).filter((task) => host.isUserTask(task));
  const run = async ({ task, args }: ManifestStep, folder: string): Promise<number | string> => {
    const found = (await userTasks()).find((held) => host.labelOf(held) === task);
    if (found === undefined) return `this machine has no user task '${task}'`;
    const withArgs = withStepArgs(host, found, args, folder);
    if (withArgs === undefined) return `its task '${task}' is no shell or process task, so it takes no arguments`;
    return await exitCodeOf(host, withArgs) ?? `its task '${task}' ended with no exit code`;
  };
  const ended = (step: ManifestStep, folder: string): Promise<number | string> =>
    run(step, folder).catch((err: unknown) => `its task '${step.task}' could not run: ${errorMessage(err)}`);
  return {
    labels: async () => (await userTasks()).map((task) => host.labelOf(task)),
    whyStepsFailed: async (steps, folder) => {
      for (const step of steps) {
        const end = await ended(step, folder);
        if (end === 0) continue;
        return typeof end === 'number' ? `step '${step.task}' exited with code ${end}` : `step '${step.task}' did not run: ${end}`;
      }
      return undefined;
    },
  };
}

// The task runs in the folder the manifest builds, with the step's arguments after its own.
function withStepArgs<Task, P extends Task, S extends Task>(
  host: HostTasks<Task, P, S, unknown>, task: Task, args: readonly string[], folder: string,
): Task | undefined {
  if (host.isProcessTask(task)) return host.withProcessArgs(task, args, folder);
  if (host.isShellTask(task)) return host.withShellArgs(task, args, folder);
  return undefined;
}

// An end can arrive before the host answers which run it started.
function exitCodeOf<Task, Run>(host: Pick<HostTasks<Task, Task, Task, Run>, 'execute' | 'onProcessEnd' | 'onEnd'>, task: Task): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const started: { run?: Run } = {};
    const exitCodes = new Map<Run, number | undefined>();
    const done = new Set<Run>();
    const settle = (): void => {
      if (started.run === undefined || !done.has(started.run)) return;
      stop();
      resolve(exitCodes.get(started.run));
    };
    const listening = [
      host.onProcessEnd((run, exitCode) => { exitCodes.set(run, exitCode); }),
      host.onEnd((run) => { done.add(run); settle(); }),
    ];
    const stop = (): void => { for (const listener of listening) listener.dispose(); };
    host.execute(task).then((run) => { started.run = run; settle(); }, (err: unknown) => {
      stop();
      reject(err instanceof Error ? err : new Error(errorMessage(err)));
    });
  });
}
