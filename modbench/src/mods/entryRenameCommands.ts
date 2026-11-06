import * as vscode from 'vscode';
import { registerAgentGesture, reportPartial, type AgentGesture, type GestureResult } from '../drivingLib/agentGesture';
import { singularArgument } from '../drivingLib/gestureEntry';
import { promptRename } from '../drivingLib/promptRename';
import { Refusal } from '../drivingLib/refusal';
import type { Instance } from '../instanceLoader/instance';
import type { ModCommands } from '../modCommands/modCommands';
import type { EntryRenameCommands, EntryRenameResult } from '../modCommands/renameEntry';
import type { Reporter } from '../ports/reporter';
import { heldTexts, type FileChanges } from '../symbolNames/symbolNames';
import { applyAnswered } from '../textDocuments/applyAnswered';
import { unsavedTexts } from '../textDocuments/heldText';
import type { SourceEditing } from '../textDocuments/sourceEditing';
import { modNameOf, runModsWriting, separatorNameOf } from './gestureEntry';
import type { ModlistNode } from './ModListProvider';
import { promptRefusal } from './nameRefusals';

export interface EntryRenameDeps {
  readonly commands: Pick<ModCommands, 'renameModNameRefusal' | 'separatorNameRefusal'>;
  readonly renames: EntryRenameCommands;
  readonly source: SourceEditing;
  readonly instance: Pick<Instance, 'value' | 'refresh' | 'quiet'>;
  readonly reporter: Reporter;
}

interface Rename {
  readonly oldName: string;
  readonly newName: string;
}

const refused = (refusal: string, detail?: string): GestureResult<string> => ({ applied: false, refusal, detail });

// symbols.md, The features, story 7: a reference that could not follow lands as a warning naming it.
function resultOf(kind: 'mod' | 'separator', { oldName }: Rename, result: EntryRenameResult): GestureResult<string> {
  const couldNot = `Could not rename "${oldName}"`;
  if (result.applied) {
    const { cannotFollow } = result;
    return {
      applied: true,
      outcome: { landed: [result.name], refused: [] },
      ...cannotFollow.length === 0 ? {} : {
        partial: [{ message: `Renamed "${oldName}" to "${result.name}". ${String(cannotFollow.length)} references to it could not follow.`, detail: cannotFollow.join('\n'), severity: 'warning' }],
      },
    };
  }
  if ('unapplied' in result) return refused(`${couldNot}: its references may be partly changed. Reverting them in git undoes it.`, result.unapplied);
  if ('refusal' in result) return refused(`Failed to rename ${kind}.`, result.refusal);
  if (!result.edited) return refused(`${couldNot}: its folder and lines were not renamed.`, result.failed);
  return refused(`${couldNot}: its references were changed, and its folder and lines were not.`, result.failed);
}

function renameGesture(
  kind: 'mod' | 'separator', { commands, renames, source, instance, reporter }: EntryRenameDeps,
): AgentGesture<ModlistNode, Rename, GestureResult<string>, { name: string }> {
  const rename = kind === 'mod' ? renames.renameMod : renames.renameSeparator;
  const nameRefusal = (value: string, own: string) => (kind === 'mod' ? commands.renameModNameRefusal(value, own) : commands.separatorNameRefusal(value, own));
  return {
    fromView: async (entry) => {
      const node = singularArgument(entry, kind);
      if (!node) return undefined;
      const oldName = node.kind === 'mod' ? node.mod.name : node.separator.name;
      const newName = await promptRename(kind === 'mod' ? 'Rename mod' : 'Rename separator', oldName,
        (value) => (value === '' ? undefined : promptRefusal(nameRefusal(value, oldName))));
      return newName === undefined ? undefined : { oldName, newName };
    },
    fromAgent: ({ argument, options: { name } }) => {
      const [only, ...more] = argument;
      if (only === undefined || more.length > 0) throw new Refusal(`An agent call to rename a ${kind} carries one ${kind}.`);
      return { oldName: kind === 'mod' ? modNameOf(only) : separatorNameOf(only), newName: name };
    },
    run: async (asked) => (asked.oldName === asked.newName ? { applied: true, outcome: { landed: [], refused: [] } } : runModsWriting(kind === 'mod' ? 'modbench.mod.rename' : 'modbench.separator.rename', instance, () => instance.quiet(() => source.oneAtATime(async () => {
      const apply = (changes: readonly FileChanges[]) => applyAnswered(source, changes, []);
      return resultOf(kind, asked, await rename({ held: heldTexts(unsavedTexts()), apply }, asked.oldName, asked.newName));
    })))),
    report: (result) => {
      if (result.applied) reportPartial(reporter, result.partial);
      else reporter.report('error', result.refusal, result.detail);
    },
  };
}

/** commands.md, `rename` under Mod and under Separator. */
export function registerEntryRenameCommands(deps: EntryRenameDeps, viewSelection: () => readonly ModlistNode[]): vscode.Disposable[] {
  return [
    registerAgentGesture('modbench.mod.rename', viewSelection, renameGesture('mod', deps)),
    registerAgentGesture('modbench.separator.rename', viewSelection, renameGesture('separator', deps)),
  ];
}
