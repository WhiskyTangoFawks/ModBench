import * as vscode from 'vscode';
import type { HostTasks } from './ports/tasks';
import type { ScriptHost } from './sourceCommands/steps';

type ProcessTask = vscode.Task & { readonly execution: vscode.ProcessExecution };
type ShellCommandTask = vscode.Task & {
  readonly execution: vscode.ShellExecution & { readonly command: string | vscode.ShellQuotedString; readonly args: (string | vscode.ShellQuotedString)[] };
};
type ShellLineTask = vscode.Task & { readonly execution: vscode.ShellExecution & { readonly commandLine: string } };

// A task VS Code fetched runs as it was fetched, whatever changed on it since, so a changed task is a new one.
function rebuilt(task: vscode.Task, execution: vscode.ProcessExecution | vscode.ShellExecution): vscode.Task {
  const changed = new vscode.Task(task.definition, vscode.TaskScope.Workspace, task.name, task.source, execution, task.problemMatchers);
  return Object.assign(changed, {
    detail: task.detail, group: task.group, isBackground: task.isBackground, presentationOptions: task.presentationOptions, runOptions: task.runOptions,
  });
}

export const hostTasks: HostTasks<vscode.Task, ProcessTask, ShellCommandTask, ShellLineTask, vscode.TaskExecution> = {
  fetch: () => vscode.tasks.fetchTasks(),
  labelOf: (task) => task.name,
  // VS Code scopes a user task to the workspace, and a folder's own task to that folder.
  isUserTask: (task) => task.scope === vscode.TaskScope.Workspace,
  isProcessTask: (task): task is ProcessTask => task.execution instanceof vscode.ProcessExecution,
  isShellTask: (task): task is ShellCommandTask | ShellLineTask => task.execution instanceof vscode.ShellExecution,
  // VS Code fetches a tasks.json shell task with no args as a command line, and one with args as a command and its args.
  isShellLineTask: (task): task is ShellLineTask => task.execution.commandLine !== undefined,
  withProcessArgs: (task, args, cwd) => rebuilt(
    task, new vscode.ProcessExecution(task.execution.process, [...task.execution.args, ...args], { ...task.execution.options, cwd })),
  withShellArgs: (task, args, cwd) => rebuilt(
    task, new vscode.ShellExecution(task.execution.command, [...task.execution.args, ...args], { ...task.execution.options, cwd })),
  withShellLine: (task, cwd) => rebuilt(task, new vscode.ShellExecution(task.execution.commandLine, { ...task.execution.options, cwd })),
  scriptTask: (label, command, args, cwd) => new vscode.Task({ type: 'modbench.script' }, vscode.TaskScope.Workspace, label, 'Modbench', new vscode.ProcessExecution(command, [...args], { cwd })),
  execute: (task) => vscode.tasks.executeTask(task),
  onProcessEnd: (listener) => vscode.tasks.onDidEndTaskProcess((event) => { listener(event.execution, event.exitCode); }),
  onEnd: (listener) => vscode.tasks.onDidEndTask((event) => { listener(event.execution); }),
};

interface PythonExtensionApi {
  readonly environments: {
    getActiveEnvironmentPath(resource?: vscode.Uri): { readonly path: string };
    resolveEnvironment(path: string): PromiseLike<{ readonly executable: { readonly uri?: vscode.Uri } } | undefined>;
  };
}

// The interpreter the Python extension selects for the window's first folder, none when no Python extension or no interpreter is there.
async function selectedInterpreter(): Promise<string | undefined> {
  const python = vscode.extensions.getExtension<PythonExtensionApi>('ms-python.python');
  if (python === undefined) return undefined;
  const { environments } = await python.activate();
  const active = environments.getActiveEnvironmentPath(vscode.workspace.workspaceFolders?.[0]?.uri);
  return (await environments.resolveEnvironment(active.path))?.executable.uri?.fsPath;
}

export const scriptHostIn = (extensionUri: vscode.Uri): ScriptHost =>
  ({ interpreter: selectedInterpreter, defaultScripts: vscode.Uri.joinPath(extensionUri, 'scripts', 'default').fsPath });
