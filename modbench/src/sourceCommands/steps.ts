import { join } from 'node:path';
import type { RunStep, TaskStep } from '../manifestAdapter/manifestAdapter';
import { errorMessage } from '../ports/errorMessage';
import type { ScriptHost } from '../ports/scriptHost';
import type { HostTasks } from '../ports/tasks';

/** The folders a step runs between: the source folder it reads its script from, and the mod's folder it runs in. */
export interface StepFolders {
  readonly sourceFolder: string;
  readonly folder: string;
}

/** A build file's steps that run outside mEdit: a user task by its label (source.md, Build, story 13), and a Modbench script (story 16). */
export interface StepTasks {
  /** The label of each user task this machine has. */
  readonly labels: () => Promise<readonly string[]>;
  /** Runs the step in the mod's folder, and answers why it did not exit with code 0, or nothing when it did. */
  readonly whyStepFailed: (step: RunStep, folders: StepFolders) => Promise<string | undefined>;
}

export function stepTasks<Task, P extends Task, C extends Task, L extends Task, Run>(host: HostTasks<Task, P, C, L, Run>, scripts: ScriptHost): StepTasks {
  const userTasks = async (): Promise<Task[]> => (await host.fetch()).filter((task) => host.isUserTask(task));
  const runTask = async ({ task, args }: TaskStep, folder: string): Promise<number | string> => {
    const found = (await userTasks()).find((held) => host.labelOf(held) === task);
    if (found === undefined) return `this machine has no user task '${task}'`;
    const withArgs = withStepArgs(host, found, task, args, folder);
    if (typeof withArgs === 'string') return withArgs;
    return await exitCodeOf(host, withArgs.task) ?? `its task '${task}' ended with no exit code`;
  };
  const runScript = async (step: Exclude<RunStep, TaskStep>, { sourceFolder, folder }: StepFolders): Promise<number | string> => {
    const interpreter = await scripts.interpreter();
    if (interpreter === undefined) return 'no Python interpreter is selected for this window: select one with Python: Select Interpreter';
    const script = step.kind === 'script' ? join(sourceFolder, step.script) : await scripts.defaultScript(step.name);
    if (script === undefined) return `Modbench ships no default script '${labelOf(step)}'`;
    return await exitCodeOf(host, host.scriptTask(labelOf(step), interpreter, [script, ...step.args], folder)) ?? 'it ended with no exit code';
  };
  const run = (step: RunStep, folders: StepFolders): Promise<number | string> => (step.kind === 'task' ? runTask(step, folders.folder) : runScript(step, folders));
  return {
    labels: async () => (await userTasks()).map((task) => host.labelOf(task)),
    whyStepFailed: async (step, folders) => {
      const label = labelOf(step);
      const end = await run(step, folders).catch((err: unknown) => `${step.kind === 'task' ? `its task '${label}'` : 'it'} could not run: ${errorMessage(err)}`);
      if (end === 0) return undefined;
      return typeof end === 'number' ? `step '${label}' exited with code ${end}` : `step '${label}' did not run: ${end}`;
    },
  };
}

const labelOf = (step: RunStep): string => {
  switch (step.kind) {
    case 'task': return step.task;
    case 'script': return step.script;
    case 'defaultScript': return step.name;
  }
};

// VS Code quotes a process's or a command's arguments; a user task names no quoting for its command line.
function withStepArgs<Task, P extends Task, C extends Task, L extends Task>(
  host: HostTasks<Task, P, C, L, unknown>, task: Task, label: string, args: readonly string[], folder: string,
): { task: Task } | string {
  if (host.isProcessTask(task)) return { task: host.withProcessArgs(task, args, folder) };
  if (!host.isShellTask(task)) return `its task '${label}' is no shell or process task, so it takes no arguments`;
  if (!host.isShellLineTask(task)) return { task: host.withShellArgs(task, args, folder) };
  if (args.length > 0) return `its task '${label}' is one command line, which takes no arguments: give the task an "args" list, which VS Code quotes`;
  return { task: host.withShellLine(task, folder) };
}

// An end can arrive before the host answers which run it started.
function exitCodeOf<Task, Run>(host: Pick<HostTasks<Task, Task, Task, Task, Run>, 'execute' | 'onProcessEnd' | 'onEnd'>, task: Task): Promise<number | undefined> {
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
