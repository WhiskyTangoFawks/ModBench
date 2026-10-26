/** VS Code's tasks, which the composition root reaches for every command that runs a step (mods.md, Build, story 14).
 *  The types are the host's own; the caller tells the kinds apart through the guards. */
export interface HostTasks<Task, ProcessTask extends Task, ShellCommandTask extends Task, ShellLineTask extends Task, Run> {
  readonly fetch: () => PromiseLike<readonly Task[]>;
  readonly labelOf: (task: Task) => string;
  readonly isUserTask: (task: Task) => boolean;
  readonly isProcessTask: (task: Task) => task is ProcessTask;
  readonly isShellTask: (task: Task) => task is ShellCommandTask | ShellLineTask;
  /** A shell task written as one command line, which takes its arguments as text. */
  readonly isShellLineTask: (task: ShellCommandTask | ShellLineTask) => task is ShellLineTask;
  /** The quote the task's shell quotes a word in whole with, when the task names one. */
  readonly strongQuoteOf: (task: ShellLineTask) => string | undefined;
  /** The task with every setting it holds, its arguments followed by `args`, running in `cwd`. */
  readonly withProcessArgs: (task: ProcessTask, args: readonly string[], cwd: string) => Task;
  readonly withShellArgs: (task: ShellCommandTask, args: readonly string[], cwd: string) => Task;
  readonly withShellLineArgs: (task: ShellLineTask, words: string, cwd: string) => Task;
  readonly execute: (task: Task) => PromiseLike<Run>;
  readonly onProcessEnd: (listener: (run: Run, exitCode: number | undefined) => void) => { dispose(): void };
  readonly onEnd: (listener: (run: Run) => void) => { dispose(): void };
}
