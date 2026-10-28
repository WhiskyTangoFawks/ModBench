import type * as vscode from 'vscode';
import type { Argument } from '../wire/argument';
import { registerTaskGesture, type TaskProblem, type TaskVerdict } from '../drivingLib/taskGesture';
import { Refusal } from '../drivingLib/refusal';
import type { Reporter } from '../ports/reporter';
import { buildFailures, buildWarnings, type Built } from './buildCommand';

/** mods.md, Build, story 15: the task builds the mods its definition names, or every source. */
export function registerBuildTask(reporter: Reporter): vscode.Disposable {
  return registerTaskGesture<Built>({ label: 'Build', command: 'modbench.mod.build', reporter, argument: modsOfDefinition, settle: buildVerdict });
}

function modsOfDefinition({ mods = [] }: vscode.TaskDefinition): Argument[] {
  if (!Array.isArray(mods) || !mods.every((mod) => typeof mod === 'string')) throw new Refusal('A build task\'s "mods" is a list of mod names.');
  return mods.map((name) => ({ kind: 'mod', name }));
}

// mods.md, Build, story 15: a refusal or a mod landed in part fails the task, and a warning does not.
function buildVerdict(result: Built): TaskVerdict {
  if (!result.applied) return { passed: false, lines: [], problems: [{ severity: 'error', message: result.refusal, detail: result.detail }] };
  const { landed, refused } = result.outcome;
  const failures: TaskProblem[] = [
    ...refused.map(({ item, reason }): TaskProblem => ({ severity: 'error', message: `Could not build "${item}":`, detail: reason })),
    ...buildFailures(result.outcome).map(({ message, detail }): TaskProblem => ({ severity: 'error', message, detail })),
  ];
  const warnings = buildWarnings(result.outcome).map(({ message, detail }): TaskProblem => ({ severity: 'warning', message, detail }));
  const passed = failures.length === 0;
  return { passed, lines: passed ? landed.map(({ mod }) => `Built "${mod}".`) : [], problems: [...failures, ...warnings] };
}
