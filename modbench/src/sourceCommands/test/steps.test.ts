import { describe, it, expect } from 'vitest';
import type { HostTasks } from '../../ports/tasks';
import { join } from 'node:path';
import type { DefaultScriptStep, ScriptStep } from '../../manifestAdapter/manifestAdapter';
import { stepTasks } from '../steps';

interface FakeTask {
  readonly label: string; readonly user: boolean; readonly kind: 'process' | 'shell' | 'shellLine' | 'custom'; readonly rebuilt?: Rebuilt;
  readonly script?: { readonly command: string; readonly args: readonly string[]; readonly cwd: string };
}

type Rebuilt =
  | { readonly as: 'process' | 'shell'; readonly args: readonly string[]; readonly cwd: string }
  | { readonly as: 'shellLine'; readonly cwd: string };

type ProcessTask = FakeTask & { readonly kind: 'process' };
type ShellTask = FakeTask & { readonly kind: 'shell' };
type ShellLineTask = FakeTask & { readonly kind: 'shellLine' };

type End = { readonly exitCode: number | undefined; readonly before?: true } | { readonly refused: string };

function hostEndingEachRunAsSaid(tasks: readonly FakeTask[], endOf: Readonly<Record<string, End>> = {}) {
  const executed: { label: string; rebuilt: Rebuilt | undefined; script?: FakeTask['script'] }[] = [];
  const processEnds = new Set<(run: object, exitCode: number | undefined) => void>();
  const ends = new Set<(run: object) => void>();
  const listen = <L>(listeners: Set<L>, listener: L) => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; };
  const finish = (run: object, exitCode: number | undefined) => {
    for (const listener of processEnds) listener(run, exitCode);
    for (const listener of ends) listener(run);
  };
  const tasksHost: HostTasks<FakeTask, ProcessTask, ShellTask, ShellLineTask, object> = {
    fetch: () => Promise.resolve(tasks),
    labelOf: (task) => task.label,
    isUserTask: (task) => task.user,
    isProcessTask: (task): task is ProcessTask => task.kind === 'process',
    isShellTask: (task): task is ShellTask | ShellLineTask => task.kind === 'shell' || task.kind === 'shellLine',
    isShellLineTask: (task): task is ShellLineTask => task.kind === 'shellLine',
    withProcessArgs: (task, args, cwd) => ({ ...task, rebuilt: { as: 'process', args, cwd } }),
    withShellArgs: (task, args, cwd) => ({ ...task, rebuilt: { as: 'shell', args, cwd } }),
    withShellLine: (task, cwd) => ({ ...task, rebuilt: { as: 'shellLine', cwd } }),
    scriptTask: (label, command, args, cwd) => ({ label, user: false, kind: 'custom', script: { command, args, cwd } }),
    execute: (task) => {
      executed.push({ label: task.label, rebuilt: task.rebuilt, ...task.script ? { script: task.script } : {} });
      const end = endOf[task.label] ?? { exitCode: 0 };
      if ('refused' in end) return Promise.reject(new Error(end.refused));
      const run = {};
      if (end.before) finish(run, end.exitCode);
      else setTimeout(() => { finish(run, end.exitCode); }, 0);
      return Promise.resolve(run);
    },
    onProcessEnd: (listener) => listen(processEnds, listener),
    onEnd: (listener) => listen(ends, listener),
  };
  return { tasksHost, executed };
}

const NO_PYTHON = { interpreter: () => Promise.resolve(undefined), defaultScripts: '/ext/scripts/default' };

const userTask = (label: string, kind: FakeTask['kind'] = 'process'): FakeTask => ({ label, user: true, kind });

describe('stepTasks', () => {
  it('names only the user tasks, never a workspace task', async () => {
    const { tasksHost } = hostEndingEachRunAsSaid([userTask('Optimise'), { label: 'Build', user: false, kind: 'process' }]);

    expect(await stepTasks(tasksHost, NO_PYTHON).labels()).toEqual(['Optimise']);
  });

  it.each<[string, FakeTask, string[], Rebuilt]>([
    ['a process task, its arguments after its own', userTask('Optimise', 'process'), ['textures', 'a b'], { as: 'process', args: ['textures', 'a b'], cwd: '/mods/Mod' }],
    ['a shell task, its arguments after its own', userTask('Optimise', 'shell'), ['textures', 'a b'], { as: 'shell', args: ['textures', 'a b'], cwd: '/mods/Mod' }],
    ['a command line, for a step with no arguments', userTask('Optimise', 'shellLine'), [], { as: 'shellLine', cwd: '/mods/Mod' }],
  ])('runs %s, in the folder the manifest builds', async (_case, task, args, rebuilt) => {
    const { tasksHost, executed } = hostEndingEachRunAsSaid([task]);

    expect(await stepTasks(tasksHost, NO_PYTHON).whyStepFailed({ kind: 'task', task: 'Optimise', args }, '/mods/Mod')).toBeUndefined();

    expect(executed).toEqual([{ label: 'Optimise', rebuilt }]);
  });

  it.each<[string, readonly FakeTask[], Readonly<Record<string, End>>, string]>([
    ['exits with another code', [userTask('A'), userTask('B')], { A: { exitCode: 2 } }, "step 'A' exited with code 2"],
    ['ends with no exit code', [userTask('A'), userTask('B')], { A: { exitCode: undefined } }, "step 'A' did not run: its task 'A' ended with no exit code"],
    ['cannot start', [userTask('A'), userTask('B')], { A: { refused: 'no shell' } }, "step 'A' did not run: its task 'A' could not run: no shell"],
    ['has only a workspace task', [{ label: 'A', user: false, kind: 'process' }, userTask('B')], {}, "step 'A' did not run: this machine has no user task 'A'"],
    ['takes no arguments', [userTask('A', 'custom'), userTask('B')], {}, "step 'A' did not run: its task 'A' is no shell or process task, so it takes no arguments"],
  ])('names why a step whose task %s failed', async (_case, tasks, endOf, why) => {
    const { tasksHost } = hostEndingEachRunAsSaid(tasks, endOf);

    expect(await stepTasks(tasksHost, NO_PYTHON).whyStepFailed({ kind: 'task', task: 'A', args: [] }, '/mods/Mod')).toBe(why);
  });

  it.each<[string, string[]]>([
    ['a plain word', ['textures']],
    ['a word holding a quote twice', ["Bob's", "Al's"]],
    ['a word shaped to run as shell code', ["x'; rm -rf ~; '"]],
  ])('refuses a step with arguments on a command line, %s included, running nothing, as no quoting can be known for it', async (_case, args) => {
    const { tasksHost, executed } = hostEndingEachRunAsSaid([userTask('A', 'shellLine')]);

    expect(await stepTasks(tasksHost, NO_PYTHON).whyStepFailed({ kind: 'task', task: 'A', args }, '/mods/Mod'))
      .toBe('step \'A\' did not run: its task \'A\' is one command line, which takes no arguments: give the task an "args" list, which VS Code quotes');

    expect(executed).toEqual([]);
  });

  it('reads an exit code that arrives before the host answers which run it started', async () => {
    const { tasksHost } = hostEndingEachRunAsSaid([userTask('A')], { A: { exitCode: 4, before: true } });

    expect(await stepTasks(tasksHost, NO_PYTHON).whyStepFailed({ kind: 'task', task: 'A', args: [] }, '/mods/Mod')).toBe("step 'A' exited with code 4");
  });

  describe('a script step', () => {
    const folders = { sourceFolder: '/src/Mod', folder: '/mods/Mod' };
    const PYTHON = { ...NO_PYTHON, interpreter: () => Promise.resolve('/venv/bin/python') };

    it.each<[string, ScriptStep | DefaultScriptStep, string]>([
      ['by its path in the source folder', { kind: 'script', script: 'fix/a.py', args: ['A.esp'] }, join('/src/Mod', 'fix/a.py')],
      ['by its name among the default scripts', { kind: 'defaultScript', name: 'clean', args: ['A.esp'] }, join('/ext/scripts/default', 'clean.py')],
    ])('runs the script %s with the selected interpreter, in the mod\'s folder, never as a task Run Task offers', async (_case, step, script) => {
      const { tasksHost, executed } = hostEndingEachRunAsSaid([]);

      expect(await stepTasks(tasksHost, PYTHON).whyScriptFailed(step, folders)).toBeUndefined();

      expect(executed).toEqual([{ label: step.kind === 'script' ? step.script : step.name, rebuilt: undefined, script: { command: '/venv/bin/python', args: [script, 'A.esp'], cwd: '/mods/Mod' } }]);
    });

    it('names why a step ran no script when the window has no interpreter, running nothing', async () => {
      const { tasksHost, executed } = hostEndingEachRunAsSaid([]);

      expect(await stepTasks(tasksHost, NO_PYTHON).whyScriptFailed({ kind: 'script', script: 'a.py', args: [] }, folders))
        .toBe("step 'a.py' did not run: no Python interpreter is selected for this window: select one with Python: Select Interpreter");
      expect(executed).toEqual([]);
    });

    it('names the exit code of a script that fails', async () => {
      const { tasksHost } = hostEndingEachRunAsSaid([], { clean: { exitCode: 3 } });

      expect(await stepTasks(tasksHost, PYTHON).whyScriptFailed({ kind: 'defaultScript', name: 'clean', args: [] }, folders)).toBe("step 'clean' exited with code 3");
    });
  });
});
