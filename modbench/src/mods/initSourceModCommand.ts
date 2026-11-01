import * as vscode from 'vscode';
import { isRefused, type InitSourceModOutcome, type PluginAddress } from '../client';
import type { Instance } from '../instanceLoader/instance';
import { runWritingGesture } from '../drivingLib/writingGesture';
import { registerAgentGesture, reportPartial, type AgentGesture, type GestureResult } from '../drivingLib/agentGesture';
import { isClickedRow } from '../drivingLib/gestureEntry';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { Reporter } from '../ports/reporter';
import type { SourceCommands } from '../sourceCommands/sourceCommands';
import { initSourceModProgressMessage } from './initSourceModProgress';
import { pluginRowName } from '../wire/pluginAddress';
import { givenByAgent, targetsOf, viewOf, type ModsGiven } from './sourceGestureTargets';

export interface InitSourceModDeps {
  /** The message line of the view the gesture was fired from, which the phase line goes on. */
  progressIn: (view: string) => { say: (message: string | undefined) => void };
  instance: Pick<Instance, 'refresh'>;
  commands: Pick<SourceCommands, 'initSourceMod'>;
  reporter: Reporter;
  onCommitted: () => Promise<void>;
  modOfOrigin: (origin: string) => string | undefined;
  /** The Plugins view's id, whose bar a gesture from a plugin row runs under. */
  pluginsView: string;
}

type InitializedSourceMod = GestureResult<InitSourceModOutcome['landed'][number], string>;

interface InitOptions { readonly commit: boolean }

type InitGiven = ModsGiven & InitOptions;

// plugins.md, Init source mod, story 1: not committing comes first.
async function pickWhetherToCommit(): Promise<boolean | undefined> {
  const picked = await vscode.window.showQuickPick(
    [{ label: 'Do not commit', commit: false }, { label: 'Commit to main', commit: true }], { placeHolder: 'Init source mod' },
  );
  return picked?.commit;
}

/** commands.md, `init source mod`: the mods of Mods rows, plugin rows, a column header, or the palette's
 *  selection, in one call. A plugin no mod provides is refused here, since mEdit is sent mods. */
export function registerInitSourceModCommand(deps: InitSourceModDeps, paletteSelection: () => readonly unknown[]): vscode.Disposable {
  const gesture: AgentGesture<unknown, InitGiven, InitializedSourceMod, InitOptions> = {
    fromView: async (entry) => {
      const targets = targetsOf(entry.selection, deps.modOfOrigin);
      const commit = targets.mods.length === 0 ? false : await pickWhetherToCommit();
      return commit === undefined ? undefined : { ...targets, commit, invokedFrom: viewOf(entry.selection, deps.pluginsView) };
    },
    fromAgent: ({ argument, options }) => ({ ...givenByAgent(argument), commit: options.commit }),
    run: ({ mods, commit, invokedFrom }) => initSourceMods(deps, mods, commit, invokedFrom),
    report: (result, { mods, refusedRows }) => reportInitiated(deps.reporter, result, mods, refusedRows),
  };
  return registerAgentGesture('modbench.mod.initSourceMod', paletteSelection, gesture, isClickedRow);
}

async function initSourceMods(
  { progressIn, instance, commands, onCommitted }: InitSourceModDeps, mods: readonly string[], commit: boolean, invokedFrom: string,
): Promise<InitializedSourceMod> {
  const [firstMod] = mods;
  if (firstMod === undefined) return { applied: true, outcome: { landed: [], refused: [] } };
  const progress = progressIn(invokedFrom);
  return runWritingGesture(invokedFrom, instance, async (): Promise<InitializedSourceMod> => {
    try {
      progress.say(initSourceModProgressMessage(firstMod, undefined));
      const result = await commands.initSourceMod(mods, {
        commit,
        onProgress: (status) => { progress.say(initSourceModProgressMessage(status.mod ?? firstMod, status.phase)); },
      });
      if (isRefused(result)) return { applied: false, refusal: result.message };
      if (result.landed.length > 0) await onCommitted();
      const { notes = [], ...outcome } = result;
      return { applied: true, outcome, ...notes.length === 0 ? {} : { partial: notes.map((detail) => ({ message: 'Init source mod:', detail, severity: 'warning' as const })) } };
    } finally {
      progress.say(undefined);
    }
  });
}

function reportInitiated(
  reporter: Reporter, result: InitializedSourceMod, mods: readonly string[], refusedRows: readonly ItemRefusal<string>[],
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

interface InitSourceModReport {
  refused: InitSourceModOutcome['refused'];
  plugins: readonly PluginAddress[];
  refusedPlugins: readonly ItemRefusal<string>[];
}

// commands.md, "each item lands on its own": one notification naming each refused mod and each
// refused plugin.
function reportRefused(reporter: Reporter, modCount: number, report: InitSourceModReport): void {
  const counts = [
    ...(report.refused.length > 0 ? [`${report.refused.length} of ${modCount} mods`] : []),
    ...(report.refusedPlugins.length > 0
      ? [`${report.refusedPlugins.length} of ${report.plugins.length + report.refusedPlugins.length} plugins`]
      : []),
  ];
  reporter.selectionOutcome(`Could not init source mod for ${counts.join(' and ')}.`, {
    landed: report.plugins.map(pluginRowName),
    refused: [
      ...report.refusedPlugins,
      ...report.refused,
    ],
  }, (name) => name);
}
