import * as vscode from 'vscode';
import { AgentCall, type GestureResult, type PartialFailure } from '../drivingLib/agentGesture';
import { runWritingGesture } from '../drivingLib/writingGesture';
import { MODS_KEY_ARGS } from './gestureEntry';
import type { Instance } from '../instanceLoader/instance';
import { modLabelsOf } from '../instanceLoader/modName';
import { everyModHere, modsOfAgent, modsToRun, type ModsToRun, type ModsToRunDeps } from './modsToRun';
import type { AskQuestion } from '../ports/dialog';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { Reporter } from '../ports/reporter';
import type {
  ModlistRepositoryCommands, ModNote, RestoreResult, RestoreStatus, UpdateManifestResult, UpdateManifestStatus,
} from '../sourceCommands/modlistRepositoryCommands';

const RESTORE = 'Restore';

export interface ManifestGestureDeps extends ModsToRunDeps {
  commands: Pick<ModlistRepositoryCommands, 'updateManifest' | 'restoreFromManifest' | 'whatRestoreDestroys'>;
  instance: Pick<Instance, 'value' | 'refresh'>;
  reporter: Reporter;
  ask: AskQuestion;
  /** The Toolbox's message line: `undefined` gives it back to whatever else had something to say. */
  say: (message: string | undefined) => void;
}

type ModlistCall = AgentCall<{ force?: boolean }>;

const isAgentCall = (value: unknown): value is ModlistCall => value instanceof AgentCall;

// A view's title bar hands its command nothing, so the Mods view's is an entry point that names every mod and the
// view (commands.md, Entry points are not gestures).
export function registerManifestGestures(deps: ManifestGestureDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('modbench.mod.updateManifest', (clicked?: unknown, selected?: readonly unknown[]) =>
      (isAgentCall(clicked) ? updateManifestForAgent(deps, clicked) : updateManifest(deps, modsToRun(deps, clicked, selected)))),
    vscode.commands.registerCommand('modbench.mod.restoreFromManifest', (clicked?: unknown, selected?: readonly unknown[]) =>
      (isAgentCall(clicked) ? restoreFromManifestForAgent(deps, clicked) : restoreFromManifest(deps, modsToRun(deps, clicked, selected)))),
    vscode.commands.registerCommand('modbench.modList.updateManifestHere', () => updateManifest(deps, everyModHere(deps))),
    vscode.commands.registerCommand('modbench.modList.restoreFromManifestHere', () => restoreFromManifest(deps, everyModHere(deps))),
  ];
}

type Label = (modName: string) => string;
const labelsOf = ({ value }: Pick<ManifestGestureDeps['instance'], 'value'>): Label => modLabelsOf(value.modFolders);

const named = <Outcome extends { landed: readonly { mod: string }[]; refused: readonly ItemRefusal<string>[] }>(label: Label, outcome: Outcome): Outcome => ({
  ...outcome,
  landed: outcome.landed.map((landed) => ({ ...landed, mod: label(landed.mod) })),
  refused: outcome.refused.map((refused) => ({ ...refused, item: label(refused.item) })),
});

type AgentOutcome<Landed> = GestureResult<Landed, string>;
type Restored = Extract<RestoreResult, { applied: true }>['landed'];

// modlist-repository.md, Every mod, story 5: progress by mod with Cancel, which stops after the mod in hand. The
// Toolbox's message line says what the notification says (Reporting).
function withProgressAndCancel<T>(
  { say }: ManifestGestureDeps, run: (show: (message: string) => void, signal: AbortSignal) => Promise<T>,
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

async function updateManifest(deps: ManifestGestureDeps, { mods, refused, view }: ModsToRun): Promise<void> {
  const { commands, instance, reporter } = deps;
  const label = labelsOf(instance);
  await runWritingGesture(view, instance, async () => {
    const outcome = await withProgressAndCancel(deps, (show, signal) =>
      commands.updateManifest(mods, { onProgress: (status) => { show(updateMessage(status, label)); }, signal }));
    if (!outcome.applied) { reporter.report('error', outcome.refusal); return; }
    reportCancelRefused(reporter, outcome);
    const answered = named(label, outcome);
    reportUpdated(reporter, label, { ...answered, refused: [...answered.refused, ...refused] });
  });
}

async function updateManifestForAgent(
  { commands, instance }: ManifestGestureDeps, { argument }: ModlistCall,
): Promise<AgentOutcome<Extract<UpdateManifestResult, { applied: true }>['landed'][number]>> {
  const label = labelsOf(instance);
  const mods = modsOfAgent(argument, instance.value);
  const result = await runWritingGesture(MODS_KEY_ARGS.view, instance, () => commands.updateManifest(mods));
  if (!result.applied) return { applied: false, refusal: result.refusal };
  const outcome = named(label, result);
  const notHeld = outcome.landed.flatMap(({ mod, notInPackage }) => notInPackage.map((path) => `${mod}: its package does not hold ${path}`));
  return {
    applied: true,
    outcome: { landed: outcome.landed, refused: outcome.refused },
    partial: warned('Update manifest:', [...notHeld, ...notesOf(label, result.notes), ...result.repositoryNotes, ...statCacheNotWritten(outcome.landed)]),
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
  const warnings = [...notHeld, ...notesOf(label, outcome.notes), ...outcome.repositoryNotes, ...statCacheNotWritten(outcome.landed)];
  const detail = [...outcome.refused.map(({ item, reason }) => `"${item}" (${reason})`), ...warnings].join('\n');
  if (outcome.refused.length > 0) reporter.report('error', line, detail);
  else if (warnings.length > 0) reporter.report('warning', line, detail);
  else reporter.landed(line);
}

function reportCancelRefused(reporter: Reporter, { cancelRefusal }: { readonly cancelRefusal?: string }): void {
  if (cancelRefusal !== undefined) reporter.report('error', cancelRefusal);
}

const quoted = (label: Label, mods: readonly string[]): string => mods.map((mod) => `"${label(mod)}"`).join(', ');

const uncommittedWarnings = (landed: Restored): string[] => landed.filter(({ uncommitted }) => uncommitted)
  .map(({ mod }) => `${mod}: its submodule holds changes no commit holds, so the commit the instance repository pins does not rebuild these bytes`);

const leftDetachedWarnings = (landed: Restored): string[] =>
  landed.flatMap(({ mod, leftDetached }) => (leftDetached ? [`${mod}: ${leftDetached}`] : []));

const repositoryNotSetUp = ({ pushRefusalNotWritten, pathTokensNotWritten }: { readonly pushRefusalNotWritten?: string; readonly pathTokensNotWritten?: string }): string[] => [
  ...(pushRefusalNotWritten === undefined ? [] : [`a push of a pin its source mod's remote lacks is not refused: ${pushRefusalNotWritten}`]),
  ...(pathTokensNotWritten === undefined ? [] : [`this machine's paths are not in place of every path token: ${pathTokensNotWritten}`]),
];

async function confirmRestore(ask: AskQuestion, label: Label, { mods, everyMod: all }: ModsToRun): Promise<boolean> {
  const manifests = mods.length === 1 ? 'its manifest' : 'their manifests';
  const target = all ? 'every mod from its manifest' : `${quoted(label, mods)} from ${manifests}`;
  const question = `Are you sure you want to restore ${target}?`;
  return (await ask(question, { modal: true, detail: 'A change no manifest holds is lost.' }, RESTORE)) === RESTORE;
}

// modlist-repository.md, Restore from manifest, story 2: the question only when the restore destroys something.
async function restoreFromManifest(deps: ManifestGestureDeps, toRun: ModsToRun): Promise<void> {
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
      commands.restoreFromManifest(toRestore, { onProgress: (status) => { show(restoreMessage(status, label)); }, signal }, toRun.everyMod));
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
  { commands, instance }: ManifestGestureDeps, { argument, options }: ModlistCall,
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
  const outcome = await runWritingGesture(MODS_KEY_ARGS.view, instance, () => commands.restoreFromManifest(toRestore, {}, argument.length === 0));
  if (!outcome.applied) {
    return { applied: false, refusal: outcome.refusal, ...(outcome.unfinished.length === 0 ? {} : { detail: `Not finished: ${quoted(label, outcome.unfinished)}. Restoring again finishes them.` }) };
  }
  const answered = named(label, { landed: outcome.landed, refused: [...outcome.refused, ...refused] });
  return {
    applied: true,
    outcome: answered,
    partial: warned('Restore from manifest:', [...statCacheNotWritten(answered.landed), ...uncommittedWarnings(answered.landed), ...leftDetachedWarnings(answered.landed), ...repositoryNotSetUp(outcome)]),
  };
}

function restoreMessage(status: RestoreStatus, label: Label): string {
  switch (status.phase) {
    case 'Cloning': return 'Restore from manifest — cloning the submodules the instance repository pins…';
    case 'ReadingFiles': return `Restore from manifest — reading the files of "${label(status.mod)}"…`;
    case 'Downloading': return `Restore from manifest — downloading "${status.file}" from Nexus…`;
    case 'Restoring': return `Restore from manifest — "${label(status.mod ?? '')}", ${status.modsDone} of ${status.modsTotal} mods done…`;
  }
}

// modlist-repository.md, Reporting: one line, with each skipped mod, each stat cache not written and each mod built from
// changes no commit holds in the Output.
function reportRestored(reporter: Reporter, total: number, outcome: Omit<Extract<RestoreResult, { applied: true }>, 'applied'>): void {
  const warnings = [
    ...statCacheNotWritten(outcome.landed), ...uncommittedWarnings(outcome.landed), ...leftDetachedWarnings(outcome.landed), ...repositoryNotSetUp(outcome),
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
