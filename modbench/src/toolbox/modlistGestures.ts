import * as vscode from 'vscode';
import { modArgumentOf, rowNameOf } from '../drivingLib/argument';
import { gestureEntry, isClickedRow } from '../drivingLib/gestureEntry';
import type { FocusedView } from '../drivingLib/focusedView';
import { runWritingGesture } from '../drivingLib/writingGesture';
import type { Instance } from '../instanceLoader/instance';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { Reporter } from '../ports/reporter';
import type { ModlistSourceCommands, StageResult, StageStatus } from '../sourceCommands/modlistSourceCommands';

const TOOLBOX_VIEW = 'modbench.toolbox';
const NOT_A_MOD = 'it is not a mod';

interface ModlistGestureDeps {
  commands: Pick<ModlistSourceCommands, 'init' | 'stage'>;
  instance: Pick<Instance, 'value' | 'refresh'>;
  reporter: Reporter;
  /** The Toolbox's message line: `undefined` gives it back to whatever else had something to say. */
  say: (message: string | undefined) => void;
  /** The palette has no clicked row, so it takes the focused view's selection. */
  focusedView: Pick<FocusedView, 'id' | 'selection'>;
  /** The Mods view's id, whose bar a gesture from a Mods row runs under. */
  modsView: string;
}

// The gestures of the Modlist (commands.md): their home is Source Control, and the Toolbox and the Mods view
// are entry points to them (modlist-source.md, Menus and keys).
export function registerModlistCommands(deps: ModlistGestureDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('modbench.modlist.init', () => init(deps)),
    vscode.commands.registerCommand('modbench.modlist.stage', (clicked?: unknown, selected?: readonly unknown[]) => stage(deps, clicked, selected)),
  ];
}

function init({ commands, instance, reporter }: ModlistGestureDeps): Promise<void> {
  return runWritingGesture(TOOLBOX_VIEW, instance, async () => {
    const result = await commands.init(instance.value);
    if (!result.applied) reporter.report('error', 'Could not init the modlist.', result.refusal);
  });
}

// A Mods row stages the selection; the palette, the Mods view's while it has the focus. Source Control's title bar
// and the Toolbox's Modlist row stage every mod.
function rowsToStage(deps: ModlistGestureDeps, clicked: unknown, selected: readonly unknown[] | undefined): readonly unknown[] {
  if (clicked === undefined) return deps.focusedView.id() === deps.modsView ? deps.focusedView.selection() : [];
  return modArgumentOf(clicked) === undefined ? [] : gestureEntry(clicked, selected, () => [], isClickedRow).selection;
}

async function stage(deps: ModlistGestureDeps, clicked: unknown, selected: readonly unknown[] | undefined): Promise<void> {
  const { commands, instance, reporter } = deps;
  const rows = rowsToStage(deps, clicked, selected);
  const refusedRows: ItemRefusal<string>[] = [];
  const mods = rows.length === 0
    ? instance.value.mods.flatMap((entry) => (entry.kind === 'mod' ? [entry.name] : []))
    : rows.flatMap((row) => {
      const mod = modArgumentOf(row);
      if (mod === undefined) refusedRows.push({ item: rowNameOf(row), reason: NOT_A_MOD });
      return mod === undefined ? [] : [mod.name];
    });
  await runWritingGesture(rows.length === 0 ? TOOLBOX_VIEW : deps.modsView, instance, async () => {
    const outcome = await commands.stage(mods, instance.value, { onProgress: (status) => { deps.say(stageMessage(status)); } })
      .finally(() => { deps.say(undefined); });
    if (!outcome.applied) { reporter.report('error', outcome.refusal); return; }
    reportStaged(reporter, mods.length + refusedRows.length, { landed: outcome.landed, refused: [...outcome.refused, ...refusedRows] });
  });
}

function stageMessage(status: StageStatus): string {
  return status.phase === 'ReadingFiles'
    ? `Staging "${status.mod}" — reading its files…`
    : `Staging "${status.mod ?? ''}" — ${status.modsDone} of ${status.modsTotal} mods staged…`;
}

// modlist-source.md, Stage, story 4, and Reporting: a refused mod is named with why, the mods that landed are not
// reported as failed, and a file nothing provides is reported so the gap is known.
function reportStaged(reporter: Reporter, total: number, outcome: Omit<Extract<StageResult, { applied: true }>, 'applied'>): void {
  const unprovided = outcome.landed.flatMap(({ mod, noProvider }) => noProvider.map((path) => `${mod}: ${path}`));
  if (unprovided.length > 0) {
    reporter.report('warning', `${unprovided.length} ${unprovided.length === 1 ? 'file has' : 'files have'} no provider.`, unprovided.join('\n'));
  }
  if (outcome.refused.length > 0) {
    reporter.selectionOutcome(
      `Could not stage ${outcome.refused.length} of ${total} mods.`, { landed: outcome.landed.map(({ mod }) => mod), refused: outcome.refused }, (mod) => mod);
    return;
  }
  const [only, ...more] = outcome.landed;
  if (only !== undefined) reporter.landed(more.length === 0 ? `Staged "${only.mod}".` : `Staged ${outcome.landed.length} mods.`);
}
