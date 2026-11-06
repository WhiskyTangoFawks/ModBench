import * as vscode from 'vscode';
import { AgentCall, registerWritingCommand, type GestureResult, type PartialFailure } from '../drivingLib/agentGesture';
import { runWritingGesture } from '../drivingLib/writingGesture';
import { MODS_KEY_ARGS } from './gestureEntry';
import type { Instance } from '../instanceLoader/instance';
import { everyModHere, modsAndSourceModsOfAgent, modsAndSourceModsToRun, modsOfAgent, modsToRun, type ModsToRun, type ModsToRunDeps } from './modsToRun';
import type { Reporter } from '../ports/reporter';
import type { InstanceRepositoryCommands, OtherManifests, RestoreResult, RestoreStatus } from '../sourceCommands/instanceRepositoryCommands';
import type { ModNote, UpdateManifestResult, UpdateManifestStatus } from '../sourceCommands/updateManifest';

export interface ManifestGestureDeps extends ModsToRunDeps {
  commands: Pick<InstanceRepositoryCommands, 'updateManifest' | 'restoreFromManifest' | 'otherManifests'>;
  instance: Pick<Instance, 'value' | 'refresh'>;
  reporter: Reporter;
  /** The Toolbox's message line: `undefined` gives it back to whatever else had something to say. */
  say: (message: string | undefined) => void;
}

type ModlistCall = AgentCall;

const isAgentCall = (value: unknown): value is ModlistCall => value instanceof AgentCall;

// A view's title bar hands its command nothing, so the Mods view's is an entry point that names every mod and the
// view (commands.md, Entry points are not gestures).
export function registerManifestGestures(deps: ManifestGestureDeps): vscode.Disposable[] {
  return [
    registerWritingCommand('modbench.mod.updateManifest', (clicked?: unknown, selected?: readonly unknown[]) =>
      (isAgentCall(clicked) ? updateManifestForAgent(deps, clicked) : updateManifest(deps, modsAndSourceModsToRun(deps, clicked, selected)))),
    registerWritingCommand('modbench.mod.restoreFromManifest', (clicked?: unknown, selected?: readonly unknown[]) =>
      (isAgentCall(clicked) ? restoreFromManifestForAgent(deps, clicked) : restoreFromManifest(deps, modsToRun(deps, clicked, selected)))),
    registerWritingCommand('modbench.modList.updateManifestHere', () => updateManifest(deps, everyModHere(deps))),
    registerWritingCommand('modbench.modList.restoreFromManifestHere', () => restoreFromManifest(deps, everyModHere(deps))),
  ];
}

// instance-repository.md, Every mod, story 1: every manifest is every mod's and every other one in the instance.
const othersOf = ({ commands }: ManifestGestureDeps, everyManifest: boolean): Promise<OtherManifests> =>
  (everyManifest ? commands.otherManifests() : Promise.resolve({ others: [], refused: [] }));

type AgentOutcome<Landed> = GestureResult<Landed, string>;
type Restored = RestoreResult['landed'];

// instance-repository.md, Every mod, story 3: progress by mod with Cancel, which stops after the mod in hand. The
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

async function updateManifest(deps: ManifestGestureDeps, { mods, sourceMods, refused, view, everyMod }: ModsToRun): Promise<void> {
  const { commands, instance, reporter } = deps;
  await runWritingGesture('modbench.mod.updateManifest', view, instance, async () => {
    const found = await othersOf(deps, everyMod);
    const outcome = await withProgressAndCancel(deps, (show, signal) =>
      commands.updateManifest(mods, { onProgress: (status) => { show(updateMessage(status)); }, signal }, found.others, everyMod, sourceMods));
    reportUpdated(reporter, { ...outcome, refused: [...outcome.refused, ...refused, ...found.refused] });
  });
}

async function updateManifestForAgent(
  deps: ManifestGestureDeps, { argument }: ModlistCall,
): Promise<AgentOutcome<UpdateManifestResult['landed'][number]>> {
  const { commands, instance } = deps;
  const { mods, sourceMods, refused } = modsAndSourceModsOfAgent(argument, instance.value);
  const found = await othersOf(deps, argument.length === 0);
  const result = await runWritingGesture('modbench.mod.updateManifest', MODS_KEY_ARGS.view, instance, () => commands.updateManifest(mods, {}, found.others, argument.length === 0, sourceMods));
  const { notHeld, otherBytes } = gapsOf(result.landed, (mod, path) => `${mod}: its package does not hold ${path}`, (mod, path) => `${mod}: its package holds ${path} with other bytes`);
  return {
    applied: true,
    outcome: { landed: result.landed, refused: [...result.refused, ...refused, ...found.refused] },
    partial: warned('Update manifest:', [...notHeld, ...otherBytes, ...notesOf(result.notes), ...result.repositoryNotes]),
  };
}

const warned = (message: string, lines: readonly string[]): PartialFailure[] =>
  lines.map((detail) => ({ message, detail, severity: 'warning' }));

const notesOf = (notes: readonly ModNote[]): string[] => notes.map(({ mod, note }) => `${mod}: ${note}`);

function updateMessage(status: UpdateManifestStatus): string {
  switch (status.phase) {
    case 'ReadingFiles': return `Update manifest — reading the files of "${status.mod}"…`;
    case 'Hashing': return `Update manifest — hashing downloaded files, ${status.left} left…`;
    case 'Updating': return `Update manifest — "${status.mod}", ${status.modsDone} of ${status.modsTotal} mods done…`;
  }
}

const counted = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

const restoredNotes = (landed: Restored): string[] => landed.flatMap(({ mod, notes = [] }) => notes.map((note) => `${mod}: ${note}`));

const gapsOf = (
  landed: readonly { mod: string; notInPackage: readonly string[]; otherBytes: readonly string[] }[],
  notHeldLine: (mod: string, path: string) => string, otherBytesLine: (mod: string, path: string) => string,
) => ({
  notHeld: landed.flatMap(({ mod, notInPackage }) => notInPackage.map((path) => notHeldLine(mod, path))),
  otherBytes: landed.flatMap(({ mod, otherBytes }) => otherBytes.map((path) => otherBytesLine(mod, path))),
});

// instance-repository.md, Reporting, story 1
function reportUpdated(reporter: Reporter, outcome: UpdateManifestResult): void {
  const { notHeld, otherBytes } = gapsOf(outcome.landed, (mod, path) => `${mod}: ${path}`, (mod, path) => `${mod}: ${path} (other bytes)`);
  const updated = outcome.landed.filter(({ manifestWritten, repositoryWritten }) => manifestWritten || repositoryWritten).length;
  const unchanged = outcome.landed.length - updated;
  const line = `Update manifest${outcome.cancelled ? ' cancelled' : ''}: ${unchanged} mod${unchanged === 1 ? '' : 's'} unchanged, ${updated} updated, `
    + `${outcome.refused.length} refused; their packages do not hold ${counted(notHeld.length, 'file', 'files')} and hold ${counted(otherBytes.length, 'file', 'files')} with other bytes.`;
  const warnings = [...notHeld, ...otherBytes, ...notesOf(outcome.notes), ...outcome.repositoryNotes];
  const detail = [...outcome.refused.map(({ item, reason }) => `"${item}" (${reason})`), ...warnings].join('\n');
  if (outcome.refused.length > 0) reporter.report('error', line, detail);
  else if (warnings.length > 0 || outcome.cancelled) reporter.report('warning', line, detail);
  else reporter.landed(line);
}


const uncommittedWarnings = (landed: Restored): string[] => landed.filter(({ uncommitted }) => uncommitted)
  .map(({ mod }) => `${mod}: its submodule holds changes no commit holds, so the commit the instance repository pins does not rebuild these bytes`);

const leftDetachedWarnings = (landed: Restored): string[] =>
  landed.flatMap(({ mod, leftDetached }) => (leftDetached ? [`${mod}: ${leftDetached}`] : []));

const repositoryNotSetUp = ({ pushRefusalNotWritten, pathTokensNotWritten }: { readonly pushRefusalNotWritten?: string; readonly pathTokensNotWritten?: string }): string[] => [
  ...(pushRefusalNotWritten === undefined ? [] : [`a push of a pin its source mod's remote lacks is not refused: ${pushRefusalNotWritten}`]),
  ...(pathTokensNotWritten === undefined ? [] : [`this machine's paths are not in place of every path token: ${pathTokensNotWritten}`]),
];

async function restoreFromManifest(deps: ManifestGestureDeps, toRun: ModsToRun): Promise<void> {
  const { commands, instance, reporter } = deps;
  const { mods, view } = toRun;
  const found = await othersOf(deps, toRun.everyMod);
  const refused = [...toRun.refused, ...found.refused];
  const total = mods.length + found.others.length + refused.length;
  if (mods.length + found.others.length === 0) {
    reportRestored(reporter, total, { landed: [], refused });
    return;
  }
  await runWritingGesture('modbench.mod.restoreFromManifest', view, instance, async () => {
    const outcome = await withProgressAndCancel(deps, (show, signal) =>
      commands.restoreFromManifest(mods, { onProgress: (status) => { show(restoreMessage(status)); }, signal }, toRun.everyMod, found.others));
    reportRestored(reporter, total, { ...outcome, refused: [...outcome.refused, ...refused] });
  });
}

async function restoreFromManifestForAgent(deps: ManifestGestureDeps, { argument }: ModlistCall): Promise<AgentOutcome<Restored[number]>> {
  const { commands, instance } = deps;
  const mods = modsOfAgent(argument, instance.value);
  const found = await othersOf(deps, argument.length === 0);
  if (mods.length + found.others.length === 0) return { applied: true, outcome: { landed: [], refused: found.refused } };
  const outcome = await runWritingGesture('modbench.mod.restoreFromManifest', MODS_KEY_ARGS.view, instance, () => commands.restoreFromManifest(mods, {}, argument.length === 0, found.others));
  return {
    applied: true,
    outcome: { landed: outcome.landed, refused: [...outcome.refused, ...found.refused] },
    partial: warned('Restore from manifest:', [...restoredNotes(outcome.landed), ...uncommittedWarnings(outcome.landed), ...leftDetachedWarnings(outcome.landed), ...repositoryNotSetUp(outcome)]),
  };
}

function restoreMessage(status: RestoreStatus): string {
  switch (status.phase) {
    case 'Cloning': return 'Restore from manifest — cloning the submodules the instance repository pins…';
    case 'Downloading': return `Restore from manifest — downloading "${status.file}" from Nexus…`;
    case 'Restoring': return `Restore from manifest — "${status.mod}", ${status.modsDone} of ${status.modsTotal} mods done…`;
  }
}

// common.md, Reporting: one line, with each skipped mod, each thing not recorded and each mod built from
// changes no commit holds in the Output.
function reportRestored(reporter: Reporter, total: number, outcome: RestoreResult): void {
  const warnings = [
    ...restoredNotes(outcome.landed), ...uncommittedWarnings(outcome.landed), ...leftDetachedWarnings(outcome.landed), ...repositoryNotSetUp(outcome),
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
