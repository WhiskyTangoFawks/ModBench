import * as vscode from 'vscode';
import type { HostTasks } from './ports/tasks';

const withExecution = (task: vscode.Task, execution: vscode.ProcessExecution | vscode.ShellExecution): vscode.Task =>
  new vscode.Task(task.definition, vscode.TaskScope.Workspace, task.name, task.source, execution, task.problemMatchers);

export const hostTasks: HostTasks<vscode.Task, vscode.TaskExecution> = {
  fetch: () => vscode.tasks.fetchTasks(),
  labelOf: (task) => task.name,
  // VS Code scopes a user task to the workspace, and a folder's own task to that folder.
  isUserTask: (task) => task.scope === vscode.TaskScope.Workspace,
  executionOf: (task) => task.execution,
  asProcess: (task, process, args, options) => withExecution(task, new vscode.ProcessExecution(process, [...args], options)),
  asShell: (task, command, args, options) => withExecution(task, new vscode.ShellExecution(command, [...args], options)),
  asShellLine: (task, commandLine, options) => withExecution(task, new vscode.ShellExecution(commandLine, options)),
  execute: (task) => vscode.tasks.executeTask(task),
  onProcessEnd: (listener) => vscode.tasks.onDidEndTaskProcess((event) => { listener(event.execution, event.exitCode); }),
  onEnd: (listener) => vscode.tasks.onDidEndTask((event) => { listener(event.execution); }),
};
