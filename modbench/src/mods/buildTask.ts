import type * as vscode from 'vscode';
import type { Argument } from '../wire/argument';
import { registerTaskGesture, type TaskVerdict } from '../drivingLib/taskGesture';
import { Refusal } from '../drivingLib/refusal';
import type { Built } from './buildCommand';

/** mods.md, Build, story 15: the task builds the mods its definition names, or every source. */
export function registerBuildTask(): vscode.Disposable {
  return registerTaskGesture<Built>({
    type: 'modbench.build', label: 'Build', command: 'modbench.mod.build', argument: modsOfDefinition, settle: buildVerdict,
  });
}

function modsOfDefinition({ mods = [] }: vscode.TaskDefinition): Argument[] {
  if (!Array.isArray(mods) || !mods.every((mod) => typeof mod === 'string')) throw new Refusal('A build task\'s "mods" is a list of mod names.');
  return mods.map((name) => ({ kind: 'mod', name }));
}

/** A refusal, or a mod that landed in part, fails the task; a warning does not (mods.md, Build, story 15). */
function buildVerdict(result: Built): TaskVerdict {
  if (!result.applied) return { passed: false, lines: [result.refusal, ...(result.detail === undefined ? [] : [result.detail])] };
  const { landed, refused } = result.outcome;
  const lines = [
    ...landed.map(({ mod }) => `Built "${mod}".`),
    ...refused.map(({ item, reason }) => `Could not build "${item}": ${reason}`),
    ...(result.partial ?? []).map(({ message, detail }) => `${message} ${detail}`),
  ];
  const failed = landed.some(({ refused: plugins, archivesRefused, failure }) => plugins.length + archivesRefused.length > 0 || failure !== undefined);
  return { passed: refused.length === 0 && !failed, lines };
}
