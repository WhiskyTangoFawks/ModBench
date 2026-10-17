import type * as vscode from 'vscode';
import { isRefused, type InitOutcome, type PluginAddress } from '../client';
import type { Instance } from '../instanceLoader/instance';
import { runWritingGesture } from '../drivingLib/writingGesture';
import { registerAgentGesture, type AgentGesture, type GestureResult } from '../drivingLib/agentGesture';
import { isClickedRow } from '../drivingLib/gestureEntry';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { Reporter } from '../ports/reporter';
import type { SourceCommands } from '../sourceCommands/sourceCommands';
import { decompileAndCommitProgressMessage } from './decompileAndCommitProgress';
import { givenByAgent, rowName, targetsOf, viewOf, type ModsGiven } from './sourceGestureTargets';

export interface DecompileAndCommitDeps {
  /** The Plugins view's message line, which the phase line goes on. */
  progress: { say: (message: string | undefined) => void };
  instance: Pick<Instance, 'refresh'>;
  commands: Pick<SourceCommands, 'decompileAndCommit'>;
  reporter: Reporter;
  onCommitted: () => Promise<void>;
  modOfOrigin: (origin: string) => string | undefined;
  /** The Plugins view's id, whose bar a gesture from a plugin row runs under. */
  pluginsView: string;
}

type DecompiledAndCommitted = GestureResult<InitOutcome['landed'][number], string>;

/** commands.md, `decompile and commit`: the mods of Mods rows, plugin rows, a column header, or the palette's
 *  selection, in one call. A plugin no mod provides is refused here, since mEdit is sent mods. */
export function registerDecompileAndCommitCommand(deps: DecompileAndCommitDeps, paletteSelection: () => readonly unknown[]): vscode.Disposable {
  const gesture: AgentGesture<unknown, ModsGiven, DecompiledAndCommitted> = {
    fromView: (entry) => ({ ...targetsOf(entry.selection, deps.modOfOrigin), invokedFrom: viewOf(entry.selection, deps.pluginsView) }),
    fromAgent: ({ argument }) => givenByAgent(argument),
    run: ({ mods, invokedFrom }) => decompileAndCommitMods(deps, mods, invokedFrom),
    report: (result, { mods, refusedRows }) => reportDecompiledAndCommitted(deps.reporter, result, mods, refusedRows),
  };
  return registerAgentGesture('modbench.mod.decompileAndCommit', paletteSelection, gesture, isClickedRow);
}

// A mega-plugin's serialization is a one-time, worst-case tens-of-seconds cost, so this runs
// under the Plugins-view progress indicator.
async function decompileAndCommitMods(
  { progress, instance, commands, onCommitted }: DecompileAndCommitDeps, mods: readonly string[], invokedFrom: string,
): Promise<DecompiledAndCommitted> {
  const [firstMod] = mods;
  if (firstMod === undefined) return { applied: true, outcome: { landed: [], refused: [] } };
  return runWritingGesture(invokedFrom, instance, async (): Promise<DecompiledAndCommitted> => {
    try {
      progress.say(decompileAndCommitProgressMessage(firstMod, { phase: 'Idle', pluginsDone: 0, pluginsTotal: 0 }));
      const result = await commands.decompileAndCommit(mods, {
        onProgress: (status) => { progress.say(decompileAndCommitProgressMessage(status.mod ?? firstMod, status)); },
      });
      if (isRefused(result)) return { applied: false, refusal: result.message };
      if (result.landed.length > 0) await onCommitted();
      return { applied: true, outcome: result };
    } finally {
      progress.say(undefined);
    }
  });
}

function reportDecompiledAndCommitted(
  reporter: Reporter, result: DecompiledAndCommitted, mods: readonly string[], refusedRows: readonly ItemRefusal<string>[],
): void {
  if (!result.applied) { reporter.report('error', result.refusal); return; }
  const { landed, refused } = result.outcome;
  if (refused.length + refusedRows.length > 0) {
    reportRefused(reporter, mods.length, { refused, plugins: landed.flatMap((mod) => mod.plugins), refusedPlugins: refusedRows });
  } else if (landed.length > 0) {
    reporter.landed(`Decompiled and committed ${mods.length === 1 ? `"${mods[0]}"` : `${mods.length} mods`}.`);
  }
}

interface DecompileAndCommitReport {
  refused: InitOutcome['refused'];
  plugins: readonly PluginAddress[];
  refusedPlugins: readonly ItemRefusal<string>[];
}

// commands.md, "each item lands on its own": one notification naming each refused mod and each
// refused plugin.
function reportRefused(reporter: Reporter, modCount: number, report: DecompileAndCommitReport): void {
  const counts = [
    ...(report.refused.length > 0 ? [`${report.refused.length} of ${modCount} mods`] : []),
    ...(report.refusedPlugins.length > 0
      ? [`${report.refusedPlugins.length} of ${report.plugins.length + report.refusedPlugins.length} plugins`]
      : []),
  ];
  reporter.selectionOutcome(`Could not decompile and commit ${counts.join(' and ')}.`, {
    landed: report.plugins.map(rowName),
    refused: [
      ...report.refusedPlugins,
      ...report.refused,
    ],
  }, (name) => name);
}
