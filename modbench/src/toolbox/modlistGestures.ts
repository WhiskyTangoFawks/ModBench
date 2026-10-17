import * as vscode from 'vscode';
import { AgentCall, argumentOfKind, type GestureResult, type PartialFailure } from '../drivingLib/agentGesture';
import { carriedArgument, rowNameOf } from '../drivingLib/argument';
import { gestureEntry, isClickedRow } from '../drivingLib/gestureEntry';
import type { FocusedView } from '../drivingLib/focusedView';
import { runWritingGesture } from '../drivingLib/writingGesture';
import { sameEntry, type EntryRef, type Instance, type InstanceValue } from '../instanceLoader/instance';
import { modLabelsOf, modNameOf } from '../instanceLoader/modName';
import type { AskQuestion } from '../ports/dialog';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { Argument } from '../wire/argument';
import type { Reporter } from '../ports/reporter';
import type {
  ModlistRepositoryCommands, ModNote, RestoreResult, RestoreStatus, UpdateManifestResult, UpdateManifestStatus,
} from '../sourceCommands/modlistRepositoryCommands';

const TOOLBOX_VIEW = 'modbench.toolbox';
const NEITHER = 'it is not a mod or a separator';
const RESTORE = 'Restore';

interface ModlistGestureDeps {
  commands: Pick<ModlistRepositoryCommands, 'gitInit' | 'updateManifest' | 'restoreFromManifest' | 'whatRestoreDestroys'>;
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
  readonly everyMod: boolean;
  readonly view: string;
}

type ModlistCall = AgentCall<{ force?: boolean }>;

const isAgentCall = (value: unknown): value is ModlistCall => value instanceof AgentCall;

// A view's title bar hands its command nothing, so the Mods view's is an entry point that names every mod and the
// view (commands.md, Entry points are not gestures).
export function registerModlistCommands(deps: ModlistGestureDeps): vscode.Disposable[] {
  const everyModHere = (): ModsToRun => ({ mods: everyMod(deps.instance.value), refused: [], everyMod: true, view: deps.modsView });
  return [
    vscode.commands.registerCommand('modbench.modlist.gitInit', (clicked?: unknown) => (isAgentCall(clicked) ? gitInitForAgent(deps) : gitInit(deps))),
    vscode.commands.registerCommand('modbench.mod.updateManifest', (clicked?: unknown, selected?: readonly unknown[]) =>
      (isAgentCall(clicked) ? updateManifestForAgent(deps, clicked) : updateManifest(deps, modsToRun(deps, clicked, selected)))),
    vscode.commands.registerCommand('modbench.mod.restoreFromManifest', (clicked?: unknown, selected?: readonly unknown[]) =>
      (isAgentCall(clicked) ? restoreFromManifestForAgent(deps, clicked) : restoreFromManifest(deps, modsToRun(deps, clicked, selected)))),
    vscode.commands.registerCommand('modbench.modList.updateManifestHere', () => updateManifest(deps, everyModHere())),
    vscode.commands.registerCommand('modbench.modList.restoreFromManifestHere', () => restoreFromManifest(deps, everyModHere())),
  ];
}

const gitInitInToolbox = ({ commands, instance }: ModlistGestureDeps) =>
  runWritingGesture(TOOLBOX_VIEW, instance, () => commands.gitInit(instance.value));

async function gitInit(deps: ModlistGestureDeps): Promise<void> {
  const result = await gitInitInToolbox(deps);
  if (!result.applied) deps.reporter.report('error', 'Could not git init.', result.refusal);
}

type Label = (modName: string) => string;
const labelsOf = ({ value }: Pick<ModlistGestureDeps['instance'], 'value'>): Label => modLabelsOf(value.modFolders);

const named = <Outcome extends { landed: readonly { mod: string }[]; refused: readonly ItemRefusal<string>[] }>(label: Label, outcome: Outcome): Outcome => ({
  ...outcome,
  landed: outcome.landed.map((landed) => ({ ...landed, mod: label(landed.mod) })),
  refused: outcome.refused.map((refused) => ({ ...refused, item: label(refused.item) })),
});

type AgentOutcome<Landed> = GestureResult<Landed, string>;
type Restored = Extract<RestoreResult, { applied: true }>['landed'];

async function gitInitForAgent(deps: ModlistGestureDeps): Promise<AgentOutcome<never>> {
  const result = await gitInitInToolbox(deps);
  return result.applied ? { applied: true, outcome: { landed: [], refused: [] } } : { applied: false, refusal: result.refusal };
}

const kindOf = (row: unknown): unknown => Reflect.get(carriedArgument(row) ?? {}, 'kind');
const isModOrSeparator = (row: unknown): boolean => kindOf(row) === 'mod' || kindOf(row) === 'separator';

function rowsOf(deps: ModlistGestureDeps, clicked: unknown, selected: readonly unknown[] | undefined): readonly unknown[] {
  if (clicked === undefined) return deps.focusedView.id() === deps.modsView ? deps.focusedView.selection() : [];
  return isModOrSeparator(clicked) ? gestureEntry(clicked, selected, () => [], isClickedRow).selection : [];
}

// modlist-repository.md, Every mod: every mod folder, in every profile, never the Mods view's rows.
const everyMod = (value: InstanceValue): string[] => (value.modFolders ?? []).map(({ modName }) => modName);

// modlist-repository.md, Every mod, story 3: a separator stands for itself and its mods.
function modsHeldBy(kind: unknown, name: string, value: InstanceValue): string[] | undefined {
  if (kind !== 'mod' && kind !== 'separator') return undefined;
  const asked: EntryRef = { kind, name };
  const entry = value.mods.find((listed) => sameEntry(value, listed, asked)) ?? asked;
  const modName = (held: EntryRef): string => modNameOf(value.modNames, held) ?? held.name;
  if (kind === 'mod') return [modName(entry)];
  const group = value.modGroups.groups.find(({ separator }) => separator.name === entry.name);
  const itself = modNameOf(value.modNames, entry);
  return [...(itself === undefined ? [] : [itself]), ...(group?.mods.map(modName) ?? [])];
}

function modsOf(row: unknown, value: InstanceValue): string[] | undefined {
  const name: unknown = Reflect.get(carriedArgument(row) ?? {}, 'name');
  return typeof name === 'string' ? modsHeldBy(kindOf(row), name, value) : undefined;
}

// commands.md, The surface supplies the Argument: an agent call may supply all of it, and none is every mod.
function modsOfAgent(argument: readonly Argument[], value: InstanceValue): string[] {
  if (argument.length === 0) return everyMod(value);
  const held = argument.flatMap((entry) => {
    const { kind, name } = argumentOfKind(entry, 'mod', 'separator');
    return modsHeldBy(kind, name, value) ?? [];
  });
  return [...new Set(held)];
}

function modsToRun(deps: ModlistGestureDeps, clicked: unknown, selected: readonly unknown[] | undefined): ModsToRun {
  const { value } = deps.instance;
  const rows = rowsOf(deps, clicked, selected);
  if (rows.length === 0) return { mods: everyMod(value), refused: [], everyMod: true, view: TOOLBOX_VIEW };
  const refused: ItemRefusal<string>[] = [];
  const mods = rows.flatMap((row) => {
    const held = modsOf(row, value);
    if (held === undefined) refused.push({ item: rowNameOf(row), reason: NEITHER });
    return held ?? [];
  });
  return { mods: [...new Set(mods)], refused, everyMod: false, view: deps.modsView };
}

// modlist-repository.md, Every mod, story 5: progress by mod with Cancel, which stops after the mod in hand. The
// Toolbox's message line says what the notification says (Reporting).
function withProgressAndCancel<T>(
  { say }: ModlistGestureDeps, run: (show: (message: string) => void, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true }, async (progress, token) => {
    const cancel = new AbortController();
    token.onCancellationRequested(() => { cancel.abort(); });
    const show = (message: string): void => { say(message); progress.report({ message }); };
    try {
      return await run(show, cancel.signal);
    } finally {
      say(undefined);
    }
  }));
}

async function updateManifest(deps: ModlistGestureDeps, { mods, refused, view }: ModsToRun): Promise<void> {
  const { commands, instance, reporter } = deps;
  const label = labelsOf(instance);
  await runWritingGesture(view, instance, async () => {
    const outcome = await withProgressAndCancel(deps, (show, signal) =>
      commands.updateManifest(mods, instance.value, { onProgress: (status) => { show(updateMessage(status, label)); }, signal }));
    if (!outcome.applied) { reporter.report('error', outcome.refusal); return; }
    reportCancelRefused(reporter, outcome);
    const answered = named(label, outcome);
    reportUpdated(reporter, label, { ...answered, refused: [...answered.refused, ...refused] });
  });
}

async function updateManifestForAgent(
  { commands, instance, modsView }: ModlistGestureDeps, { argument }: ModlistCall,
): Promise<AgentOutcome<Extract<UpdateManifestResult, { applied: true }>['landed'][number]>> {
  const label = labelsOf(instance);
  const mods = modsOfAgent(argument, instance.value);
  const result = await runWritingGesture(modsView, instance, () => commands.updateManifest(mods, instance.value));
  if (!result.applied) return { applied: false, refusal: result.refusal };
  const outcome = named(label, result);
  const notHeld = outcome.landed.flatMap(({ mod, notInPackage }) => notInPackage.map((path) => `${mod}: its package does not hold ${path}`));
  return {
    applied: true,
    outcome: { landed: outcome.landed, refused: outcome.refused },
    partial: warned('Update manifest:', [...notHeld, ...notesOf(label, result.notes), ...result.submoduleNotes, ...statCacheNotWritten(outcome.landed)]),
  };
}

const warned = (message: string, lines: readonly string[]): PartialFailure[] =>
  lines.map((detail) => ({ message, detail, severity: 'warning' }));

const notesOf = (label: Label, notes: readonly ModNote[]): string[] => notes.map(({ mod, note }) => `${label(mod)}: ${note}`);

function updateMessage(status: UpdateManifestStatus, label: Label): string {
  return status.phase === 'ReadingFiles'
    ? `Update manifest — reading the files of "${label(status.mod)}"…`
    : `Update manifest — "${label(status.mod ?? '')}", ${status.modsDone} of ${status.modsTotal} mods done…`;
}

const counted = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

const statCacheNotWritten = (landed: readonly { mod: string; statCacheNotWritten?: string | null }[]): string[] =>
  landed.flatMap(({ mod, statCacheNotWritten: why }) => (why ? [`${mod}: the stat cache could not be written: ${why}`] : []));

// modlist-repository.md, Update manifest, story 8: one line, the modlist's validation, with each refused mod and each
// file its package does not hold in the Output.
function reportUpdated(reporter: Reporter, label: Label, outcome: Omit<Extract<UpdateManifestResult, { applied: true }>, 'applied'>): void {
  const notHeld = outcome.landed.flatMap(({ mod, notInPackage }) => notInPackage.map((path) => `${mod}: ${path}`));
  const updated = outcome.landed.filter(({ manifestWritten }) => manifestWritten).length;
  const unchanged = outcome.landed.length - updated;
  const line = `Update manifest: ${unchanged} mod${unchanged === 1 ? '' : 's'} unchanged, ${updated} updated, `
    + `${outcome.refused.length} refused; their packages do not hold ${counted(notHeld.length, 'file', 'files')}.`;
  const warnings = [...notHeld, ...notesOf(label, outcome.notes), ...outcome.submoduleNotes, ...statCacheNotWritten(outcome.landed)];
  const detail = [...outcome.refused.map(({ item, reason }) => `"${item}" (${reason})`), ...warnings].join('\n');
  if (outcome.refused.length > 0) reporter.report('error', line, detail);
  else if (warnings.length > 0) reporter.report('warning', line, detail);
  else reporter.landed(line);
}

function reportCancelRefused(reporter: Reporter, { cancelRefusal }: { readonly cancelRefusal?: string }): void {
  if (cancelRefusal !== undefined) reporter.report('error', cancelRefusal);
}

const quoted = (label: Label, mods: readonly string[]): string => mods.map((mod) => `"${label(mod)}"`).join(', ');

const uncommittedWarnings = (landed: Restored): string[] => landed.filter(({ uncommitted }) => uncommitted === true)
  .map(({ mod }) => `${mod}: its submodule holds changes no commit holds, so the commit the instance repository pins does not rebuild these bytes`);

const leftDetachedWarnings = (landed: Restored): string[] =>
  landed.flatMap(({ mod, leftDetached }) => (leftDetached ? [`${mod}: ${leftDetached}`] : []));

const pushNotRefused = ({ pushRefusalNotWritten: why }: { readonly pushRefusalNotWritten?: string }): string[] =>
  (why === undefined ? [] : [`a push of a pin its source mod's remote lacks is not refused: ${why}`]);

async function confirmRestore(ask: AskQuestion, label: Label, { mods, everyMod: all }: ModsToRun): Promise<boolean> {
  const manifests = mods.length === 1 ? 'its manifest' : 'their manifests';
  const target = all ? 'every mod from its manifest' : `${quoted(label, mods)} from ${manifests}`;
  const question = `Are you sure you want to restore ${target}?`;
  return (await ask(question, { modal: true, detail: 'A change no manifest holds is lost.' }, RESTORE)) === RESTORE;
}

// modlist-repository.md, Restore from manifest, story 2: the question only when the restore destroys something.
async function restoreFromManifest(deps: ModlistGestureDeps, toRun: ModsToRun): Promise<void> {
  const { commands, instance, reporter } = deps;
  const { mods, refused, view } = toRun;
  const label = labelsOf(instance);
  if (mods.length === 0) {
    reportRestored(reporter, refused.length, named(label, { landed: [], refused }));
    return;
  }
  deps.say('Restore from manifest — reading what it would destroy…');
  const listing = await commands.whatRestoreDestroys(mods).finally(() => { deps.say(undefined); });
  if ('refusal' in listing) { reporter.report('error', listing.refusal); return; }
  const skipped = new Set(listing.refused.map(({ item }) => item));
  const toRestore = mods.filter((mod) => !skipped.has(mod));
  const notAsked = [...listing.refused, ...refused];
  if (toRestore.length === 0) {
    reportRestored(reporter, mods.length + refused.length, named(label, { landed: [], refused: notAsked }));
    return;
  }
  if (listing.destroys.length > 0 && !(await confirmRestore(deps.ask, label, toRun))) return;
  await runWritingGesture(view, instance, async () => {
    const outcome = await withProgressAndCancel(deps, (show, signal) =>
      commands.restoreFromManifest(toRestore, instance.value, { onProgress: (status) => { show(restoreMessage(status, label)); }, signal }));
    if (!outcome.applied) {
      reporter.report('error', outcome.refusal, outcome.unfinished.length === 0
        ? undefined
        : `Not finished: ${quoted(label, outcome.unfinished)}. Restoring again finishes them.`);
      return;
    }
    reportCancelRefused(reporter, outcome);
    reportRestored(reporter, mods.length + refused.length, named(label, { ...outcome, refused: [...outcome.refused, ...notAsked] }));
  });
}

// agent.md, Any agent, story 7: a mod whose restore would overwrite what neither git nor the trash keeps is refused
// until the request forces.
async function restoreFromManifestForAgent(
  { commands, instance, modsView }: ModlistGestureDeps, { argument, options }: ModlistCall,
): Promise<AgentOutcome<Restored[number]>> {
  const label = labelsOf(instance);
  const mods = modsOfAgent(argument, instance.value);
  const listing = await commands.whatRestoreDestroys(mods);
  if ('refusal' in listing) return { applied: false, refusal: listing.refusal };
  const overwrites = options.force === true ? [] : listing.destroys
    .filter(({ differing, metadataDiffers }) => differing.length > 0 || metadataDiffers)
    .map(({ mod, differing, metadataDiffers }) => ({
      item: mod,
      reason: `it would overwrite ${[
        ...differing.length > 0 ? [`files whose bytes differ from its manifest: ${differing.join(', ')}`] : [],
        ...metadataDiffers ? ["the version or installation files its metadata names with its manifest's"] : [],
      ].join(' and ')}. Request it again with force to overwrite them.`,
    }));
  const refused = [...listing.refused, ...overwrites];
  const notRestored = new Set(refused.map(({ item }) => item));
  const toRestore = mods.filter((mod) => !notRestored.has(mod));
  if (toRestore.length === 0) return { applied: true, outcome: named(label, { landed: [], refused }) };
  const outcome = await runWritingGesture(modsView, instance, () => commands.restoreFromManifest(toRestore, instance.value));
  if (!outcome.applied) {
    return { applied: false, refusal: outcome.refusal, ...(outcome.unfinished.length === 0 ? {} : { detail: `Not finished: ${quoted(label, outcome.unfinished)}. Restoring again finishes them.` }) };
  }
  const answered = named(label, { landed: outcome.landed, refused: [...outcome.refused, ...refused] });
  return {
    applied: true,
    outcome: answered,
    partial: warned('Restore from manifest:', [...statCacheNotWritten(answered.landed), ...uncommittedWarnings(answered.landed), ...leftDetachedWarnings(answered.landed), ...pushNotRefused(outcome)]),
  };
}

function restoreMessage(status: RestoreStatus, label: Label): string {
  switch (status.phase) {
    case 'ReadingFiles': return `Restore from manifest — reading the files of "${label(status.mod)}"…`;
    case 'Restoring': return `Restore from manifest — "${label(status.mod ?? '')}", ${status.modsDone} of ${status.modsTotal} mods done…`;
  }
}

// modlist-repository.md, Reporting: one line, with each skipped mod, each stat cache not written and each mod built from
// changes no commit holds in the Output.
function reportRestored(reporter: Reporter, total: number, outcome: Omit<Extract<RestoreResult, { applied: true }>, 'applied'>): void {
  const warnings = [
    ...statCacheNotWritten(outcome.landed), ...uncommittedWarnings(outcome.landed), ...leftDetachedWarnings(outcome.landed), ...pushNotRefused(outcome),
  ];
  if (outcome.refused.length > 0) {
    const detail = [...outcome.refused.map(({ item, reason }) => `"${item}" (${reason})`), ...warnings].join('\n');
    reporter.report('error', `Could not restore ${outcome.refused.length} of ${total} mods.`, detail);
    return;
  }
  const changed = outcome.landed.filter(({ written, namedByNoLine }) => written.length + namedByNoLine.length > 0);
  if (warnings.length > 0) reporter.report('warning', restoredLine(changed), warnings.join('\n'));
  else if (changed.length > 0) reporter.landed(restoredLine(changed));
}

function restoredLine([only, ...more]: readonly { mod: string }[]): string {
  if (only === undefined) return 'Restore from manifest: no file differed from its manifest.';
  return more.length === 0 ? `Restored "${only.mod}" from its manifest.` : `Restored ${more.length + 1} mods from their manifests.`;
}
