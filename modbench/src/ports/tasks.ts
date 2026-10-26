/** A shell word, plain or quoted as VS Code quotes it. */
export type TaskWord = string | { readonly value: string; readonly quoting: number };

/** Where a task runs and with what environment, and the shell a shell task runs in. */
export interface TaskOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly executable?: string;
  readonly shellArgs?: string[];
}

/** VS Code's tasks, reached through the host, which the composition root implements and hands every command that runs
 *  a step (mods.md, Build, story 14). Task and Run are the host's own; each decision is the caller's. */
export interface HostTasks<Task, Run> {
  readonly fetch: () => PromiseLike<readonly Task[]>;
  readonly labelOf: (task: Task) => string;
  readonly isUserTask: (task: Task) => boolean;
  /** The task's execution as the host holds it, which the caller reads by its shape. */
  readonly executionOf: (task: Task) => unknown;
  readonly asProcess: (task: Task, process: string, args: readonly string[], options: TaskOptions) => Task;
  readonly asShell: (task: Task, command: TaskWord, args: readonly TaskWord[], options: TaskOptions) => Task;
  readonly asShellLine: (task: Task, commandLine: string, options: TaskOptions) => Task;
  readonly execute: (task: Task) => PromiseLike<Run>;
  readonly onProcessEnd: (listener: (run: Run, exitCode: number | undefined) => void) => { dispose(): void };
  readonly onEnd: (listener: (run: Run) => void) => { dispose(): void };
}
