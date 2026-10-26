import { describe, it, expect } from 'vitest';
import type { HostTasks } from '../../ports/tasks';
import { stepTasks } from '../steps';

interface FakeTask {
  readonly label: string; readonly user: boolean; readonly kind: 'process' | 'shell' | 'shellLine' | 'custom'; readonly quote?: string; readonly rebuilt?: Rebuilt;
}

type Rebuilt =
  | { readonly as: 'process' | 'shell'; readonly args: readonly string[]; readonly cwd: string }
  | { readonly as: 'shellLine'; readonly words: string; readonly cwd: string };

type ProcessTask = FakeTask & { readonly kind: 'process' };
type ShellTask = FakeTask & { readonly kind: 'shell' };
type ShellLineTask = FakeTask & { readonly kind: 'shellLine' };

type End = { readonly exitCode: number | undefined; readonly before?: true } | { readonly refused: string };

function hostEndingEachRunAsSaid(tasks: readonly FakeTask[], endOf: Readonly<Record<string, End>> = {}) {
  const executed: { label: string; rebuilt: Rebuilt | undefined }[] = [];
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
    strongQuoteOf: (task) => task.quote,
    withProcessArgs: (task, args, cwd) => ({ ...task, rebuilt: { as: 'process', args, cwd } }),
    withShellArgs: (task, args, cwd) => ({ ...task, rebuilt: { as: 'shell', args, cwd } }),
    withShellLineArgs: (task, words, cwd) => ({ ...task, rebuilt: { as: 'shellLine', words, cwd } }),
    execute: (task) => {
      executed.push({ label: task.label, rebuilt: task.rebuilt });
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

const userTask = (label: string, kind: FakeTask['kind'] = 'process', quote?: string): FakeTask => ({ label, user: true, kind, ...(quote === undefined ? {} : { quote }) });

describe('stepTasks', () => {
  it('names only the user tasks, never a workspace task', async () => {
    const { tasksHost } = hostEndingEachRunAsSaid([userTask('Optimise'), { label: 'Build', user: false, kind: 'process' }]);

    expect(await stepTasks(tasksHost).labels()).toEqual(['Optimise']);
  });

  it.each<[string, FakeTask, Rebuilt]>([
    ['a process task, its arguments', userTask('Optimise', 'process'), { as: 'process', args: ['textures', 'a b'], cwd: '/mods/Mod' }],
    ['a shell task, its arguments', userTask('Optimise', 'shell'), { as: 'shell', args: ['textures', 'a b'], cwd: '/mods/Mod' }],
    ['a command line, its words in the task\'s own quote', userTask('Optimise', 'shellLine', '"'), { as: 'shellLine', words: '"textures" "a b"', cwd: '/mods/Mod' }],
    ['a command line naming no quote, its words in single quotes', userTask('Optimise', 'shellLine'), { as: 'shellLine', words: "'textures' 'a b'", cwd: '/mods/Mod' }],
  ])('runs %s, in the folder the manifest builds, handing the host the step\'s arguments to follow its own', async (_case, task, rebuilt) => {
    const { tasksHost, executed } = hostEndingEachRunAsSaid([task]);

    expect(await stepTasks(tasksHost).whyStepsFailed([{ task: 'Optimise', args: ['textures', 'a b'] }], '/mods/Mod')).toBeUndefined();

    expect(executed).toEqual([{ label: 'Optimise', rebuilt }]);
  });

  it.each<[string, readonly FakeTask[], Readonly<Record<string, End>>, string]>([
    ['exits with another code', [userTask('A'), userTask('B')], { A: { exitCode: 2 } }, "step 'A' exited with code 2"],
    ['ends with no exit code', [userTask('A'), userTask('B')], { A: { exitCode: undefined } }, "step 'A' did not run: its task 'A' ended with no exit code"],
    ['cannot start', [userTask('A'), userTask('B')], { A: { refused: 'no shell' } }, "step 'A' did not run: its task 'A' could not run: no shell"],
    ['has only a workspace task', [{ label: 'A', user: false, kind: 'process' }, userTask('B')], {}, "step 'A' did not run: this machine has no user task 'A'"],
    ['takes no arguments', [userTask('A', 'custom'), userTask('B')], {}, "step 'A' did not run: its task 'A' is no shell or process task, so it takes no arguments"],
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
