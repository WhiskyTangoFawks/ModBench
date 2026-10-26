import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => {
  class ProcessExecution { constructor(readonly process: string, readonly args: string[], readonly options?: object) {} }
  class ShellExecution { constructor(readonly command: string, readonly args: string[], readonly options?: object) {} }
  class Task {
    detail?: string; group?: object; isBackground = false; presentationOptions = {}; runOptions = {};
    constructor(
      readonly definition: object, readonly scope: unknown, readonly name: string, readonly source: string,
      readonly execution: unknown, readonly problemMatchers: string[] = [],
    ) {}
  }
  return { ProcessExecution, ShellExecution, Task, TaskScope: { Global: 1, Workspace: 2 }, tasks: {} };
});

import * as vscode from 'vscode';
import { hostTasks } from '../tasks';

const SETTINGS = {
  detail: 'Optimises textures', group: { id: 'build' }, isBackground: true, presentationOptions: { reveal: 2 }, runOptions: { reevaluateOnRerun: false },
};

const userTask = <E extends vscode.ProcessExecution | vscode.ShellExecution>(execution: E) => Object.assign(
  new vscode.Task({ type: 'shell' }, vscode.TaskScope.Workspace, 'Optimise', 'Workspace', execution, ['$cao']), SETTINGS, { execution },
);

const shellTask = (command: string, args: string[], options: vscode.ShellExecutionOptions) =>
  userTask(Object.assign(new vscode.ShellExecution(command, args, options), { command, args }));

describe('hostTasks', () => {
  it.each<[string, () => vscode.Task, object]>([
    ['a process task, keeping its environment',
      () => hostTasks.withProcessArgs(userTask(new vscode.ProcessExecution('/tools/cao', ['--quiet'], { cwd: '/elsewhere', env: { CAO: 'on' } })), ['textures'], '/mods/Mod'),
      { process: '/tools/cao', args: ['--quiet', 'textures'], options: { cwd: '/mods/Mod', env: { CAO: 'on' } } }],
    ['a shell task, keeping its shell and its quoting',
      () => hostTasks.withShellArgs(shellTask('cao', ['--quiet'], { executable: '/bin/bash', shellQuoting: { strong: '\'' } }), ['textures'], '/mods/Mod'),
      { command: 'cao', args: ['--quiet', 'textures'], options: { cwd: '/mods/Mod', executable: '/bin/bash', shellQuoting: { strong: '\'' } } }],
  ])('rebuilds %s, with every setting of the task, the step\'s arguments after its own, in the folder', (_case, rebuild, execution) => {
    expect(rebuild()).toMatchObject({
      definition: { type: 'shell' }, scope: vscode.TaskScope.Workspace, name: 'Optimise', source: 'Workspace', problemMatchers: ['$cao'], ...SETTINGS, execution,
    });
  });
});
