/** VS Code's tasks, which the composition root reaches for every command that runs a step (mods.md, Build, story 14).
 *  The types are the host's own; the caller tells the kinds apart through the guards. */
export interface HostTasks<Task, ProcessTask extends Task, ShellCommandTask extends Task, ShellLineTask extends Task, Run> {
  readonly fetch: () => PromiseLike<readonly Task[]>;
  readonly labelOf: (task: Task) => string;
  readonly isUserTask: (task: Task) => boolean;
  readonly isProcessTask: (task: Task) => task is ProcessTask;
  readonly isShellTask: (task: Task) => task is ShellCommandTask | ShellLineTask;
  /** A shell task written as one command line, which VS Code hands to its shell as text. */
  readonly isShellLineTask: (task: ShellCommandTask | ShellLineTask) => task is ShellLineTask;
  /** The task with every setting it holds, its arguments followed by `args`, running in `cwd`. */
  readonly withProcessArgs: (task: ProcessTask, args: readonly string[], cwd: string) => Task;
  readonly withShellArgs: (task: ShellCommandTask, args: readonly string[], cwd: string) => Task;
  /** The task with every setting it holds, running in `cwd`. */
  readonly withShellLine: (task: ShellLineTask, cwd: string) => Task;
  readonly execute: (task: Task) => PromiseLike<Run>;
  readonly onProcessEnd: (listener: (run: Run, exitCode: number | undefined) => void) => { dispose(): void };
  readonly onEnd: (listener: (run: Run) => void) => { dispose(): void };
}
