import * as vscode from 'vscode';
import type { HostTasks } from './ports/tasks';

type ProcessTask = vscode.Task & { readonly execution: vscode.ProcessExecution };
// VS Code fetches a shell task of a tasks.json as a command and its arguments, never as a command line.
type ShellTask = vscode.Task & {
  readonly execution: vscode.ShellExecution & { readonly command: string | vscode.ShellQuotedString; readonly args: (string | vscode.ShellQuotedString)[] };
};

// A task VS Code fetched runs as it was fetched, whatever changed on it since, so a changed task is a new one.
function rebuilt(task: vscode.Task, execution: vscode.ProcessExecution | vscode.ShellExecution): vscode.Task {
  const changed = new vscode.Task(task.definition, vscode.TaskScope.Workspace, task.name, task.source, execution, task.problemMatchers);
  return Object.assign(changed, {
    detail: task.detail, group: task.group, isBackground: task.isBackground, presentationOptions: task.presentationOptions, runOptions: task.runOptions,
  });
}

export const hostTasks: HostTasks<vscode.Task, ProcessTask, ShellTask, vscode.TaskExecution> = {
  fetch: () => vscode.tasks.fetchTasks(),
  labelOf: (task) => task.name,
  // VS Code scopes a user task to the workspace, and a folder's own task to that folder.
  isUserTask: (task) => task.scope === vscode.TaskScope.Workspace,
  isProcessTask: (task): task is ProcessTask => task.execution instanceof vscode.ProcessExecution,
  isShellTask: (task): task is ShellTask => task.execution instanceof vscode.ShellExecution,
  withProcessArgs: (task, args, cwd) => rebuilt(
    task, new vscode.ProcessExecution(task.execution.process, [...task.execution.args, ...args], { ...task.execution.options, cwd })),
  withShellArgs: (task, args, cwd) => rebuilt(
    task, new vscode.ShellExecution(task.execution.command, [...task.execution.args, ...args], { ...task.execution.options, cwd })),
  execute: (task) => vscode.tasks.executeTask(task),
  onProcessEnd: (listener) => vscode.tasks.onDidEndTaskProcess((event) => { listener(event.execution, event.exitCode); }),
  onEnd: (listener) => vscode.tasks.onDidEndTask((event) => { listener(event.execution); }),
};
