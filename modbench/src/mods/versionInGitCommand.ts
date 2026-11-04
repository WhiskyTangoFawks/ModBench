import * as vscode from 'vscode';
import { isRefused, type VersionInGitOutcome, type PluginAddress } from '../client';
import type { Instance } from '../instanceLoader/instance';
import { refusedAnswer, runWritingGesture } from '../drivingLib/writingGesture';
import { registerAgentGesture, reportPartial, type AgentGesture, type GestureResult, type PartialFailure } from '../drivingLib/agentGesture';
import { isClickedRow } from '../drivingLib/gestureEntry';
import { pickWhereGitHolds } from '../drivingLib/whereGitHolds';
import { errorMessage } from '../ports/errorMessage';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { Reporter } from '../ports/reporter';
import type { SourceCommands, VersionInGitWhere } from '../sourceCommands/sourceCommands';
import { versionInGitProgressMessage } from './versionInGitProgress';
import { pluginRowName } from '../wire/pluginAddress';
import { givenByAgent, targetsOf, viewOf, type ModsGiven } from './sourceGestureTargets';

export interface VersionInGitDeps {
  /** The message line of the view the gesture was fired from, which the phase line goes on. */
  progressIn: (view: string) => { say: (message: string | undefined) => void };
  instance: Pick<Instance, 'refresh' | 'value'>;
  commands: Pick<SourceCommands, 'versionInGit'>;
  reporter: Reporter;
  onCommitted: () => Promise<void>;
  modOfOrigin: (origin: string) => string | undefined;
  /** The Plugins view's id, whose bar a gesture from a plugin row runs under. */
  pluginsView: string;
}

type VersionedInGit = GestureResult<VersionInGitOutcome['landed'][number], string>;

interface VersionInGitOptions { readonly commit: boolean; readonly where: VersionInGitWhere }

type VersionInGitGiven = ModsGiven & VersionInGitOptions;


// plugins.md, Version in git, story 1: not committing comes first.
async function pickWhetherToCommit(): Promise<boolean | undefined> {
  const picked = await vscode.window.showQuickPick(
    [{ label: 'Do not commit', commit: false }, { label: 'Commit', commit: true }], { placeHolder: 'Version in git' },
  );
  return picked?.commit;
}

async function pickOptions(holdsRepository: boolean): Promise<VersionInGitOptions | undefined> {
  const where = await pickWhereGitHolds(holdsRepository, 'Version in git', true);
  const commit = where === undefined ? undefined : await pickWhetherToCommit();
  return where === undefined || commit === undefined ? undefined : { where, commit };
}

/** commands.md, `version in git`: the mods of Mods rows, plugin rows, a column header, or the palette's
 *  selection, in one call. A plugin no mod provides is refused here, since mEdit is sent mods. */
export function registerVersionInGitCommand(deps: VersionInGitDeps, paletteSelection: () => readonly unknown[]): vscode.Disposable {
  const gesture: AgentGesture<unknown, VersionInGitGiven, VersionedInGit, VersionInGitOptions> = {
    fromView: async (entry) => {
      const targets = targetsOf(entry.selection, deps.modOfOrigin);
      const options = targets.mods.length === 0 ? { where: 'NewRepository' as const, commit: false } : await pickOptions(deps.instance.value.holdsRepository);
      return options === undefined ? undefined : { ...targets, ...options, invokedFrom: viewOf(entry.selection, deps.pluginsView) };
    },
    fromAgent: ({ argument, options }) => ({ ...givenByAgent(argument), commit: options.commit, where: options.where }),
    run: ({ mods, commit, where, invokedFrom }) => versionModsInGit(deps, mods, { commit, where }, invokedFrom),
    report: (result, { mods, refusedRows, where }) => reportVersioned(deps.reporter, result, mods, refusedRows, where),
  };
  return registerAgentGesture('modbench.mod.versionInGit', paletteSelection, gesture, isClickedRow);
}

async function versionModsInGit(
  { progressIn, instance, commands, onCommitted }: VersionInGitDeps, mods: readonly string[], options: VersionInGitOptions, invokedFrom: string,
): Promise<VersionedInGit> {
  const [firstMod] = mods;
  if (firstMod === undefined) return { applied: true, outcome: { landed: [], refused: [] } };
  const progress = progressIn(invokedFrom);
  const makesSourceMods = options.where !== 'WholeFolder';
  const result = await runWritingGesture('modbench.mod.versionInGit', invokedFrom, instance, async (): Promise<VersionedInGit> => {
    try {
      progress.say(versionInGitProgressMessage(firstMod, undefined));
      const result = await commands.versionInGit(mods, {
        ...options,
        onProgress: (status) => { progress.say(versionInGitProgressMessage(status.mod ?? firstMod, status.phase)); },
      });
      if (isRefused(result)) return refusedAnswer(result.message);
      if (makesSourceMods && result.landed.length > 0) await onCommitted();
      const { notes = [], ...outcome } = result;
      return { applied: true, outcome, ...notes.length === 0 ? {} : { partial: notes.map((detail) => ({ message: 'Version in git:', detail, severity: 'warning' as const })) } };
    } finally {
      progress.say(undefined);
    }
  });
  const lastLanded = result.applied && makesSourceMods ? result.outcome.landed.at(-1) : undefined;
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
  reporter: Reporter, result: VersionedInGit, mods: readonly string[], refusedRows: readonly ItemRefusal<string>[], where: VersionInGitWhere,
): void {
  if (!result.applied) { reporter.report('error', result.refusal); return; }
  reportPartial(reporter, result.partial);
  const { landed, refused } = result.outcome;
  if (refused.length + refusedRows.length > 0) {
    reportRefused(reporter, mods.length, { refused, plugins: landed.flatMap((mod) => mod.plugins), refusedPlugins: refusedRows });
  } else if (landed.length > 0) {
    const [one, many] = where !== 'WholeFolder' ? ['a source mod', 'source mods'] : ['held whole by git', 'held whole by git'];
    reporter.landed(mods.length === 1 ? `"${mods[0]}" is ${one}.` : `${mods.length} mods are ${many}.`);
  }
}

interface VersionInGitReport {
  refused: VersionInGitOutcome['refused'];
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
