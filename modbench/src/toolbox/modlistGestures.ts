import * as vscode from 'vscode';
import { modArgumentOf, rowNameOf } from '../drivingLib/argument';
import { gestureEntry, isClickedRow } from '../drivingLib/gestureEntry';
import type { FocusedView } from '../drivingLib/focusedView';
import { runWritingGesture } from '../drivingLib/writingGesture';
import type { Instance } from '../instanceLoader/instance';
import type { AskQuestion } from '../ports/dialog';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { Reporter } from '../ports/reporter';
import type { DiscardResult, DiscardStatus, ModlistSourceCommands, StageResult, StageStatus } from '../sourceCommands/modlistSourceCommands';

const TOOLBOX_VIEW = 'modbench.toolbox';
const NOT_A_MOD = 'it is not a mod';
const DISCARD = 'Discard Changes';

interface ModlistGestureDeps {
  commands: Pick<ModlistSourceCommands, 'init' | 'stage' | 'discardChanges' | 'modsHolding'>;
  instance: Pick<Instance, 'value' | 'refresh'>;
  reporter: Reporter;
  ask: AskQuestion;
  /** The Toolbox's message line: `undefined` gives it back to whatever else had something to say. */
  say: (message: string | undefined) => void;
  /** The palette has no clicked row, so it takes the focused view's selection. */
  focusedView: Pick<FocusedView, 'id' | 'selection'>;
  /** The Mods view's id, whose bar a gesture from a Mods row runs under. */
  modsView: string;
}

interface ModsToRun {
  readonly mods: readonly string[];
  readonly refused: readonly ItemRefusal<string>[];
  /** No selection named the mods. */
  readonly every: boolean;
  /** The view whose progress bar the gesture runs under. */
  readonly view: string;
}

// The gestures of the Modlist (commands.md): their home is Source Control, and the Toolbox and the Mods view
// are entry points to them (modlist-source.md, Menus and keys).
export function registerModlistCommands(deps: ModlistGestureDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('modbench.modlist.init', () => init(deps)),
    vscode.commands.registerCommand('modbench.modlist.stage', (clicked?: unknown, selected?: readonly unknown[]) => stage(deps, modsToRun(deps, clicked, selected))),
    vscode.commands.registerCommand(
      'modbench.modlist.discardChanges', (clicked?: unknown, selected?: readonly unknown[]) => discardChanges(deps, modsToRun(deps, clicked, selected))),
    // Source Control hands each selected row of its provider as an argument, and a row names a file.
    vscode.commands.registerCommand('modbench.modlist.discardChangesInModFolder', (...rows: unknown[]) => {
      const held = deps.commands.modsHolding(rows.flatMap(filePathOf), deps.instance.value);
      return discardChanges(deps, { ...held, every: false, view: TOOLBOX_VIEW });
    }),
  ];
}

function filePathOf(row: unknown): string[] {
  const uri: unknown = typeof row === 'object' && row !== null ? Reflect.get(row, 'resourceUri') : undefined;
  const path: unknown = typeof uri === 'object' && uri !== null ? Reflect.get(uri, 'fsPath') : undefined;
  return typeof path === 'string' ? [path] : [];
}

function init({ commands, instance, reporter }: ModlistGestureDeps): Promise<void> {
  return runWritingGesture(TOOLBOX_VIEW, instance, async () => {
    const result = await commands.init(instance.value);
    if (!result.applied) reporter.report('error', 'Could not init the modlist.', result.refusal);
  });
}

// A Mods row runs on the selection; the palette, on the Mods view's while it has the focus. Source Control's title
// bar and the Toolbox's Modlist row run on every mod.
function rowsOf(deps: ModlistGestureDeps, clicked: unknown, selected: readonly unknown[] | undefined): readonly unknown[] {
  if (clicked === undefined) return deps.focusedView.id() === deps.modsView ? deps.focusedView.selection() : [];
  return modArgumentOf(clicked) === undefined ? [] : gestureEntry(clicked, selected, () => [], isClickedRow).selection;
}

function modsToRun(deps: ModlistGestureDeps, clicked: unknown, selected: readonly unknown[] | undefined): ModsToRun {
  const rows = rowsOf(deps, clicked, selected);
  if (rows.length === 0) {
    return { mods: deps.instance.value.mods.flatMap((entry) => (entry.kind === 'mod' ? [entry.name] : [])), refused: [], every: true, view: TOOLBOX_VIEW };
  }
  const refused: ItemRefusal<string>[] = [];
  const mods = rows.flatMap((row) => {
    const mod = modArgumentOf(row);
    if (mod === undefined) refused.push({ item: rowNameOf(row), reason: NOT_A_MOD });
    return mod === undefined ? [] : [mod.name];
  });
  return { mods, refused, every: false, view: deps.modsView };
}

async function stage(deps: ModlistGestureDeps, { mods, refused, view }: ModsToRun): Promise<void> {
  const { commands, instance, reporter } = deps;
  await runWritingGesture(view, instance, async () => {
    const outcome = await commands.stage(mods, instance.value, { onProgress: (status) => { deps.say(stageMessage(status)); } })
      .finally(() => { deps.say(undefined); });
    if (!outcome.applied) { reporter.report('error', outcome.refusal); return; }
    reportStaged(reporter, mods.length + refused.length, { landed: outcome.landed, refused: [...outcome.refused, ...refused] });
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

const quoted = (mods: readonly string[]): string => mods.map((mod) => `"${mod}"`).join(', ');

// modlist-source.md, Discard changes, story 2: one question, as VS Code's Discard Changes asks.
async function confirmDiscard(ask: AskQuestion, { mods, every }: ModsToRun): Promise<boolean> {
  const question = `Are you sure you want to discard changes in ${every ? 'every mod' : quoted(mods)}?`;
  return (await ask(question, { modal: true, detail: 'Changes not staged and committed are lost.' }, DISCARD)) === DISCARD;
}

async function discardChanges(deps: ModlistGestureDeps, toRun: ModsToRun): Promise<void> {
  const { commands, instance, reporter } = deps;
  const { mods, refused, view } = toRun;
  if (mods.length === 0) {
    reportDiscarded(reporter, refused.length, { landed: [], refused });
    return;
  }
  if (!(await confirmDiscard(deps.ask, toRun))) return;
  await runWritingGesture(view, instance, async () => {
    const outcome = await commands.discardChanges(mods, instance.value, { onProgress: (status) => { deps.say(discardMessage(status)); } })
      .finally(() => { deps.say(undefined); });
    if (!outcome.applied) {
      reporter.report('error', outcome.refusal, outcome.unfinished.length === 0
        ? undefined
        : `Not finished: ${quoted(outcome.unfinished)}. Discarding changes again finishes them.`);
      return;
    }
    reportDiscarded(reporter, mods.length + refused.length, { landed: outcome.landed, refused: [...outcome.refused, ...refused] });
  });
}

function discardMessage(status: DiscardStatus): string {
  switch (status.phase) {
    case 'ReadingFiles': return `Discarding changes in "${status.mod}" — reading its files…`;
    case 'Discarding': return `Discarding changes in "${status.mod ?? ''}" — ${status.modsDone} of ${status.modsTotal} mods done…`;
    case 'ReadingDownloadedFile': return `Discarding changes — searching "${status.file}" for deltas…`;
  }
}

// modlist-source.md, Reporting: a skipped mod is named with what it lacks, and the mods that landed are not reported as
// failed. A discard that wrote nothing says nothing (commands.md, Doing nothing is not an error).
function reportDiscarded(reporter: Reporter, total: number, outcome: Omit<Extract<DiscardResult, { applied: true }>, 'applied'>): void {
  if (outcome.refused.length > 0) {
    reporter.selectionOutcome(
      `Could not discard changes in ${outcome.refused.length} of ${total} mods.`,
      { landed: outcome.landed.map(({ mod }) => mod), refused: outcome.refused }, (mod) => mod);
    return;
  }
  const [only, ...more] = outcome.landed.filter(({ written }) => written.length > 0);
  if (only !== undefined) reporter.landed(more.length === 0 ? `Discarded changes in "${only.mod}".` : `Discarded changes in ${more.length + 1} mods.`);
}
