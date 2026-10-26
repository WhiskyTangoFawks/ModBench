import * as vscode from 'vscode';
import { errorMessage } from '../ports/errorMessage';
import type { Tasks } from '../ports/tasks';

export const tasks: Tasks = {
  labels: async () => (await vscode.tasks.fetchTasks()).map((task) => task.name),
  run: async (label, args, folder) => {
    const found = (await vscode.tasks.fetchTasks()).find((task) => task.name === label);
    if (found === undefined) return `this machine has no task '${label}'`;
    const execution = withArgs(found.execution, args, folder);
    if (execution === undefined) return `its task '${label}' is no shell or process task, so it takes no arguments`;
    return ended(new vscode.Task(found.definition, found.scope ?? vscode.TaskScope.Workspace, found.name, found.source, execution, found.problemMatchers));
  },
};

const ESCAPED_QUOTE = String.raw`\"`;

// A step's arguments follow the task's own, and its task runs in the folder the manifest builds.
function withArgs(
  execution: vscode.Task['execution'], args: readonly string[], cwd: string,
): vscode.ShellExecution | vscode.ProcessExecution | undefined {
  if (execution instanceof vscode.ProcessExecution) return new vscode.ProcessExecution(execution.process, [...execution.args, ...args], { ...execution.options, cwd });
  if (!(execution instanceof vscode.ShellExecution)) return undefined;
  const options = { ...execution.options, cwd };
  if (execution.command !== undefined) return new vscode.ShellExecution(execution.command, [...(execution.args ?? []), ...args], options);
  return new vscode.ShellExecution([execution.commandLine ?? '', ...args.map((arg) => `"${arg.replaceAll('"', ESCAPED_QUOTE)}"`)].join(' '), options);
}

// The exit code of the task's process, or why it ended with none. An end can arrive before executeTask answers.
function ended(task: vscode.Task): Promise<number | string> {
  return new Promise((resolve, reject) => {
    let execution: vscode.TaskExecution | undefined;
    const exitCodes = new Map<vscode.TaskExecution, number | undefined>();
    const done = new Set<vscode.TaskExecution>();
    const listening = [
      vscode.tasks.onDidEndTaskProcess((event) => { exitCodes.set(event.execution, event.exitCode); }),
      vscode.tasks.onDidEndTask((event) => { done.add(event.execution); settle(); }),
    ];
    const stop = (): void => { for (const listener of listening) listener.dispose(); };
    const settle = (): void => {
      if (execution === undefined || !done.has(execution)) return;
      stop();
      resolve(exitCodes.get(execution) ?? `its task '${task.name}' ended with no exit code`);
    };
    vscode.tasks.executeTask(task).then((started) => { execution = started; settle(); }, (err: unknown) => {
      stop();
      reject(err instanceof Error ? err : new Error(errorMessage(err)));
    });
  });
}
