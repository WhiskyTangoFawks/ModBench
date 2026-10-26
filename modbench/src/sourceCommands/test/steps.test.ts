import { describe, it, expect } from 'vitest';
import type { HostTasks, TaskOptions, TaskWord } from '../../ports/tasks';
import { stepTasks } from '../steps';

type Rebuilt =
  | { readonly kind: 'process'; readonly process: string; readonly args: readonly string[]; readonly options: TaskOptions }
  | { readonly kind: 'shell'; readonly command: TaskWord; readonly args: readonly TaskWord[]; readonly options: TaskOptions }
  | { readonly kind: 'shellLine'; readonly commandLine: string; readonly options: TaskOptions };

interface FakeTask { readonly label: string; readonly user: boolean; readonly execution: unknown; readonly rebuilt?: Rebuilt }

type End = { readonly exitCode: number | undefined; readonly before?: true } | { readonly refused: string };

function hostEndingEachRunAsSaid(tasks: readonly FakeTask[], endOf: Readonly<Record<string, End>> = {}) {
  const executed: { label: string; execution: Rebuilt | undefined }[] = [];
  const processEnds = new Set<(run: object, exitCode: number | undefined) => void>();
  const ends = new Set<(run: object) => void>();
  const listen = <L>(listeners: Set<L>, listener: L) => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; };
  const withRebuilt = (task: FakeTask, rebuilt: Rebuilt): FakeTask => ({ ...task, rebuilt });
  const finish = (run: object, exitCode: number | undefined) => {
    for (const listener of processEnds) listener(run, exitCode);
    for (const listener of ends) listener(run);
  };
  const tasksHost: HostTasks<FakeTask, object> = {
    fetch: () => Promise.resolve(tasks),
    labelOf: (task) => task.label,
    isUserTask: (task) => task.user,
    executionOf: (task) => task.execution,
    asProcess: (task, process, args, options) => withRebuilt(task, { kind: 'process', process, args, options }),
    asShell: (task, command, args, options) => withRebuilt(task, { kind: 'shell', command, args, options }),
    asShellLine: (task, commandLine, options) => withRebuilt(task, { kind: 'shellLine', commandLine, options }),
    execute: (task) => {
      executed.push({ label: task.label, execution: task.rebuilt });
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

const PROCESS = { process: '/tools/cao', args: ['--quiet'], options: { cwd: '/elsewhere', env: { CAO: 'on', BAD: 7 } } };
const userTask = (label: string, execution: unknown = PROCESS): FakeTask => ({ label, user: true, execution });

describe('stepTasks', () => {
  it('names only the user tasks, never a workspace task', async () => {
    const { tasksHost } = hostEndingEachRunAsSaid([userTask('Optimise'), { label: 'Build', user: false, execution: PROCESS }]);

    expect(await stepTasks(tasksHost).labels()).toEqual(['Optimise']);
  });

  it.each<[string, unknown, Rebuilt]>([
    ['a process task', PROCESS, { kind: 'process', process: '/tools/cao', args: ['--quiet', 'textures', 'a b'], options: { cwd: '/mods/Mod', env: { CAO: 'on' } } }],
    ['a shell task', { command: 'cao', args: [{ value: 'x y', quoting: 1 }], options: { executable: '/bin/bash', shellArgs: ['-c'] } },
      { kind: 'shell', command: 'cao', args: [{ value: 'x y', quoting: 1 }, 'textures', 'a b'], options: { cwd: '/mods/Mod', env: {}, executable: '/bin/bash', shellArgs: ['-c'] } }],
    ['a shell command line', { commandLine: 'cao --quiet' }, { kind: 'shellLine', commandLine: 'cao --quiet "textures" "a b"', options: { cwd: '/mods/Mod', env: {} } }],
  ])('runs %s in the folder the manifest builds, with the step\'s arguments after its own', async (_case, execution, expected) => {
    const { tasksHost, executed } = hostEndingEachRunAsSaid([userTask('Optimise', execution)]);

    expect(await stepTasks(tasksHost).whyStepsFailed([{ task: 'Optimise', args: ['textures', 'a b'] }], '/mods/Mod')).toBeUndefined();

    expect(executed).toEqual([{ label: 'Optimise', execution: expected }]);
  });

  it.each<[string, readonly FakeTask[], Readonly<Record<string, End>>, string]>([
    ['exits with another code', [userTask('A'), userTask('B')], { A: { exitCode: 2 } }, "step 'A' exited with code 2"],
    ['ends with no exit code', [userTask('A'), userTask('B')], { A: { exitCode: undefined } }, "step 'A' did not run: its task 'A' ended with no exit code"],
    ['cannot start', [userTask('A'), userTask('B')], { A: { refused: 'no shell' } }, "step 'A' did not run: its task 'A' could not run: no shell"],
    ['has only a workspace task', [{ label: 'A', user: false, execution: PROCESS }, userTask('B')], {}, "step 'A' did not run: this machine has no user task 'A'"],
    ['takes no arguments', [userTask('A', {}), userTask('B')], {}, "step 'A' did not run: its task 'A' is no shell or process task, so it takes no arguments"],
  ])('stops at a step whose task %s, naming why, and runs no step after it', async (_case, tasks, endOf, why) => {
    const { tasksHost, executed } = hostEndingEachRunAsSaid(tasks, endOf);

    expect(await stepTasks(tasksHost).whyStepsFailed([{ task: 'A', args: [] }, { task: 'B', args: [] }], '/mods/Mod')).toBe(why);

    expect(executed.map(({ label }) => label)).not.toContain('B');
  });

  it('reads an exit code that arrives before the host answers which run it started', async () => {
    const { tasksHost } = hostEndingEachRunAsSaid([userTask('A')], { A: { exitCode: 4, before: true } });

    expect(await stepTasks(tasksHost).whyStepsFailed([{ task: 'A', args: [] }], '/mods/Mod')).toBe("step 'A' exited with code 4");
  });
});
