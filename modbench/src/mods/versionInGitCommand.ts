import * as vscode from 'vscode';
import { isRefused, type InitSourceModOutcome, type PluginAddress } from '../client';
import type { Instance } from '../instanceLoader/instance';
import { runWritingGesture } from '../drivingLib/writingGesture';
import { registerAgentGesture, reportPartial, type AgentGesture, type GestureResult, type PartialFailure } from '../drivingLib/agentGesture';
import { isClickedRow } from '../drivingLib/gestureEntry';
import { errorMessage } from '../ports/errorMessage';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { Reporter } from '../ports/reporter';
import type { SourceCommands } from '../sourceCommands/sourceCommands';
import { versionInGitProgressMessage } from './versionInGitProgress';
import { pluginRowName } from '../wire/pluginAddress';
import { givenByAgent, targetsOf, viewOf, type ModsGiven } from './sourceGestureTargets';

export interface VersionInGitDeps {
  /** The message line of the view the gesture was fired from, which the phase line goes on. */
  progressIn: (view: string) => { say: (message: string | undefined) => void };
  instance: Pick<Instance, 'refresh' | 'value'>;
  commands: Pick<SourceCommands, 'initSourceMod'>;
  reporter: Reporter;
  onCommitted: () => Promise<void>;
  modOfOrigin: (origin: string) => string | undefined;
  /** The Plugins view's id, whose bar a gesture from a plugin row runs under. */
  pluginsView: string;
}

type VersionedInGit = GestureResult<InitSourceModOutcome['landed'][number], string>;

interface VersionInGitOptions { readonly commit: boolean }

type VersionInGitGiven = ModsGiven & VersionInGitOptions;

// plugins.md, Version in git, story 1: not committing comes first.
async function pickWhetherToCommit(): Promise<boolean | undefined> {
  const picked = await vscode.window.showQuickPick(
    [{ label: 'Do not commit', commit: false }, { label: 'Commit to main', commit: true }], { placeHolder: 'Version in git' },
  );
  return picked?.commit;
}

/** commands.md, `version in git`: the mods of Mods rows, plugin rows, a column header, or the palette's
 *  selection, in one call. A plugin no mod provides is refused here, since mEdit is sent mods. */
export function registerVersionInGitCommand(deps: VersionInGitDeps, paletteSelection: () => readonly unknown[]): vscode.Disposable {
  const gesture: AgentGesture<unknown, VersionInGitGiven, VersionedInGit, VersionInGitOptions> = {
    fromView: async (entry) => {
      const targets = targetsOf(entry.selection, deps.modOfOrigin);
      const commit = targets.mods.length === 0 ? false : await pickWhetherToCommit();
      return commit === undefined ? undefined : { ...targets, commit, invokedFrom: viewOf(entry.selection, deps.pluginsView) };
    },
    fromAgent: ({ argument, options }) => ({ ...givenByAgent(argument), commit: options.commit }),
    run: ({ mods, commit, invokedFrom }) => versionModsInGit(deps, mods, commit, invokedFrom),
    report: (result, { mods, refusedRows }) => reportVersioned(deps.reporter, result, mods, refusedRows),
  };
  return registerAgentGesture('modbench.mod.versionInGit', paletteSelection, gesture, isClickedRow);
}

async function versionModsInGit(
  { progressIn, instance, commands, onCommitted }: VersionInGitDeps, mods: readonly string[], commit: boolean, invokedFrom: string,
): Promise<VersionedInGit> {
  const [firstMod] = mods;
  if (firstMod === undefined) return { applied: true, outcome: { landed: [], refused: [] } };
  const progress = progressIn(invokedFrom);
  const result = await runWritingGesture(invokedFrom, instance, async (): Promise<VersionedInGit> => {
    try {
      progress.say(versionInGitProgressMessage(firstMod, undefined));
      const result = await commands.initSourceMod(mods, {
        commit,
        onProgress: (status) => { progress.say(versionInGitProgressMessage(status.mod ?? firstMod, status.phase)); },
      });
      if (isRefused(result)) return { applied: false, refusal: result.message };
      if (result.landed.length > 0) await onCommitted();
      const { notes = [], ...outcome } = result;
      return { applied: true, outcome, ...notes.length === 0 ? {} : { partial: notes.map((detail) => ({ message: 'Version in git:', detail, severity: 'warning' as const })) } };
    } finally {
      progress.say(undefined);
    }
  });
  const lastLanded = result.applied ? result.outcome.landed.at(-1) : undefined;
  if (!result.applied || lastLanded === undefined) return result;
  const unshown = await showInExplorer(instance.value.paths.sourceDirs.get(lastLanded.mod), lastLanded.mod);
  return unshown === undefined ? result : { ...result, partial: [...result.partial ?? [], unshown] };
}

// plugins.md, Version in git, story 7: the source is shown in the Explorer when it lands.
async function showInExplorer(folder: string | undefined, mod: string): Promise<PartialFailure | undefined> {
  try {
    if (folder === undefined) throw new Error('the instance names no source folder for it');
    await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(folder));
    return undefined;
  } catch (err) {
    return { message: 'Version in git:', detail: `"${mod}" is a source mod, but its source could not be shown in the Explorer: ${errorMessage(err)}`, severity: 'warning' };
  }
}

function reportVersioned(
  reporter: Reporter, result: VersionedInGit, mods: readonly string[], refusedRows: readonly ItemRefusal<string>[],
): void {
  if (!result.applied) { reporter.report('error', result.refusal); return; }
  reportPartial(reporter, result.partial);
  const { landed, refused } = result.outcome;
  if (refused.length + refusedRows.length > 0) {
    reportRefused(reporter, mods.length, { refused, plugins: landed.flatMap((mod) => mod.plugins), refusedPlugins: refusedRows });
  } else if (landed.length > 0) {
    reporter.landed(mods.length === 1 ? `"${mods[0]}" is a source mod.` : `${mods.length} mods are source mods.`);
  }
}

interface VersionInGitReport {
  refused: InitSourceModOutcome['refused'];
  plugins: readonly PluginAddress[];
  refusedPlugins: readonly ItemRefusal<string>[];
}

// commands.md, "each item lands on its own": one notification naming each refused mod and each
// refused plugin.
function reportRefused(reporter: Reporter, modCount: number, report: VersionInGitReport): void {
  const counts = [
    ...(report.refused.length > 0 ? [`${report.refused.length} of ${modCount} mods`] : []),
    ...(report.refusedPlugins.length > 0
      ? [`${report.refusedPlugins.length} of ${report.plugins.length + report.refusedPlugins.length} plugins`]
      : []),
  ];
  reporter.selectionOutcome(`Could not put ${counts.join(' and ')} under git.`, {
    landed: report.plugins.map(pluginRowName),
    refused: [
      ...report.refusedPlugins,
      ...report.refused,
    ],
  }, (name) => name);
}
