import * as vscode from 'vscode';
import { isRefused } from '../client';
import type { SourceFilesOf } from '../instanceLoader/loadOrderSnapshot';
import type { Instance } from '../instanceLoader/instance';
import { answeringRefusal, RefusedGesture, runWritingGesture } from '../drivingLib/writingGesture';
import { registerAgentGesture, reportPartial, type AgentGesture, type GestureResult, type PartialFailure } from '../drivingLib/agentGesture';
import { isClickedRow } from '../drivingLib/gestureEntry';
import type { ReportAction, Reporter } from '../ports/reporter';
import type { SourceBuildOutcome as BuildOutcome } from '../sourceCommands/buildSourceMod';
import type { SourceCommands } from '../sourceCommands/sourceCommands';
import type { BuildProblems } from './buildProblems';
import { pluginRowName } from '../wire/pluginAddress';
import { givenByAgent, targetsOf, viewOf, type ModsGiven } from './sourceGestureTargets';
import { MODS_KEY_ARGS } from './gestureEntry';

/** What build needs: the build itself, the Instance loader's refresh, where the diagnostics go, and
 *  how the user is told. */
export interface BuildDeps {
  commands: Pick<SourceCommands, 'build'>;
  instance: Pick<Instance, 'refresh'>;
  reporter: Reporter;
  problems: BuildProblems;
  sourceFiles: SourceFilesOf;
  modOfOrigin: (origin: string) => string | undefined;
  sourceModNames: () => Iterable<string>;
  /** The Plugins view's id, whose bar a gesture from a plugin row runs under. */
  pluginsView: string;
}

export type Built = GestureResult<BuildOutcome['landed'][number], string>;

/** commands.md, `build`: the mods a row, the selection or the palette's pick names, and from an agent call naming none, every source. */
export function registerBuildCommand(deps: BuildDeps, paletteSelection: () => readonly unknown[]): vscode.Disposable {
  const gesture: AgentGesture<unknown, BuildGiven, Built> = {
    fromView: async (entry) => {
      const targets = targetsOf(entry.selection, deps.modOfOrigin);
      const named = entry.clicked !== undefined || targets.mods.length > 0 || targets.refusedRows.length > 0;
      if (named) return { ...targets, invokedFrom: viewOf(entry.selection, deps.pluginsView), everySource: false };
      const mods = await pickSourceMods(deps.sourceModNames());
      return mods === undefined ? undefined : { mods, refusedRows: [], invokedFrom: MODS_KEY_ARGS.view, everySource: false };
    },
    fromAgent: ({ argument }) => ({ ...givenByAgent(argument), everySource: argument.length === 0 }),
    run: (given) => buildMods(deps, given),
    report: (result) => reportBuildResult(deps.reporter, result),
  };
  return registerAgentGesture('modbench.mod.build', paletteSelection, gesture, isClickedRow);
}

// source.md, Build, story 7: from the palette with no source mod selected, a pick of every source.
async function pickSourceMods(sourceModNames: Iterable<string>): Promise<string[] | undefined> {
  const items = [...sourceModNames].sort().map((label) => ({ label }));
  const picked = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: 'Build which mods?' });
  return picked?.map((item) => item.label);
}

interface BuildGiven extends ModsGiven {
  readonly everySource: boolean;
}

async function buildMods(deps: BuildDeps, { mods, refusedRows, invokedFrom, everySource }: BuildGiven): Promise<Built> {
  const { commands, instance } = deps;
  if (mods.length === 0 && !everySource) return { applied: true, outcome: { landed: [], refused: refusedRows } };
  return answeringRefusal(runWritingGesture('modbench.mod.build', invokedFrom, instance, async (): Promise<Built> => {
    const outcome = await commands.build(mods, everySource);
    if (isRefused(outcome)) throw new RefusedGesture(outcome.message);
    for (const { compiled } of outcome.landed) {
      for (const plugin of compiled) deps.problems.publish(plugin, deps.sourceFiles(plugin.origin), plugin.diagnostics);
    }
    return {
      applied: true,
      outcome: { landed: outcome.landed, refused: [...refusedRows, ...outcome.refused] },
      partial: [...partlyBuilt(outcome), ...buildWarnings(outcome), ...refusedInMods(outcome)],
    };
  }));
}

function reportBuildResult(reporter: Reporter, result: Built): void {
  if (!result.applied) { reporter.report('error', result.refusal, result.detail); return; }
  const lacksATask = result.outcome.refused.some((refused) => 'lacksATask' in refused && refused.lacksATask === true);
  reportBuilt(reporter, result.outcome, lacksATask ? OPEN_USER_TASKS : undefined);
  reportPartial(reporter, result.partial);
}

function diagnosticsWords(count: number): string {
  return `${count} ${count === 1 ? 'diagnostic' : 'diagnostics'}. See the Problems panel.`;
}

// source.md, Build, story 13: a tool this machine has no task for is added as a user task.
const OPEN_USER_TASKS: ReportAction = {
  title: 'Open User Tasks', run: () => { void vscode.commands.executeCommand('workbench.action.tasks.openUserTasks'); },
};

// source.md, Build, story 6, and common.md, Reporting: one notification when it lands, naming each
// refused mod and plugin and why, and pointing at the Problems panel when it left diagnostics.
function reportBuilt(reporter: Reporter, outcome: BuildOutcome, action: ReportAction | undefined): void {
  const compiled = outcome.landed.flatMap((built) => built.compiled);
  const refusedPlugins = outcome.landed.flatMap((built) => built.refused);
  const refusedArchives = outcome.landed.flatMap(({ mod, archivesRefused }) =>
    archivesRefused.map(({ item, reason }) => ({ item: inMod(item, mod), reason })));
  const diagnostics = compiled.reduce((sum, plugin) => sum + plugin.diagnostics.length, 0);
  if (outcome.refused.length + refusedPlugins.length + refusedArchives.length > 0) {
    const counts = [
      ...(outcome.refused.length > 0 ? [`${outcome.refused.length} of ${outcome.landed.length + outcome.refused.length} mods`] : []),
      ...(refusedPlugins.length > 0 ? [`${refusedPlugins.length} of ${compiled.length + refusedPlugins.length} plugins`] : []),
      ...(refusedArchives.length > 0 ? [`${refusedArchives.length} ${refusedArchives.length === 1 ? 'archive' : 'archives'}`] : []),
    ];
    const rest = diagnostics > 0 ? ` The rest compiled with ${diagnosticsWords(diagnostics)}` : '';
    reporter.selectionOutcome(`Could not build ${counts.join(' and ')}.${rest}`, {
      landed: outcome.landed.map((built) => built.mod),
      refused: [...outcome.refused, ...refusedPlugins.map(({ item, reason }) => ({ item: pluginRowName(item), reason })), ...refusedArchives],
    }, (name) => name, action);
    return;
  }
  const [only, ...more] = outcome.landed;
  if (only === undefined) return;
  const what = more.length === 0 ? `"${only.mod}"` : `${outcome.landed.length} mods`;
  reporter.landed(diagnostics > 0 ? `Built ${what} with ${diagnosticsWords(diagnostics)}` : `Built ${what}.`);
}

/** The mods of a landed build that landed whole. */
export const builtWhole = (outcome: BuildOutcome): string[] =>
  outcome.landed.filter(({ failure, refused, archivesRefused }) => failure === undefined && refused.length + archivesRefused.length === 0).map(({ mod }) => mod);

/** The parts of a landed build that did not land whole. */
export const buildFailures = (outcome: BuildOutcome): PartialFailure[] => [...partlyBuilt(outcome), ...refusedInMods(outcome)];

/** What a landed build says and the build still succeeded. */
export const buildWarnings = (outcome: BuildOutcome): PartialFailure[] =>
  [...builtUncommitted(outcome), ...builtUnpushed(outcome), ...builtOverIgnored(outcome)];

// common.md, Reporting: a mod whose build stopped after it began writing landed, and the part that failed is named.
function partlyBuilt(outcome: BuildOutcome): PartialFailure[] {
  const partly = outcome.landed.flatMap(({ mod, failure }) => (failure === undefined ? [] : [`"${mod}" (${failure})`]));
  return partly.length === 0 ? [] : [{
    message: `Built ${partly.length} mod${partly.length === 1 ? '' : 's'} only in part.`, detail: partly.join(', '), severity: 'warning',
  }];
}

function builtUncommitted(outcome: BuildOutcome): PartialFailure[] {
  return namedBuilt(outcome.landed.filter(({ uncommitted }) => uncommitted === true), {
    one: 'Built 1 mod from changes no commit holds, so the commit the instance repository pins does not rebuild it.',
    many: (count) => `Built ${count} mods from changes no commit holds, so the commits the instance repository pins do not rebuild them.`,
  });
}

// instance-repository.md, The manifest, story 11: a step that would write a path the manifest ignores leaves it as it is.
function builtOverIgnored(outcome: BuildOutcome): PartialFailure[] {
  return outcome.landed.flatMap(({ mod, ignored = [] }) => ignored.map((path) => ({
    message: `Left "${path}" in "${mod}" unwritten, as its manifest ignores it.`, detail: path, severity: 'warning' as const,
  })));
}

// A clone elsewhere fetches the commit the manifest names from the remote.
function builtUnpushed(outcome: BuildOutcome): PartialFailure[] {
  return namedBuilt(outcome.landed.filter(({ unpushed }) => unpushed === true), {
    one: 'Built 1 mod at a commit its remote does not hold, so a clone elsewhere cannot fetch it.',
    many: (count) => `Built ${count} mods at commits their remotes do not hold, so a clone elsewhere cannot fetch them.`,
  });
}

function namedBuilt(mods: readonly { mod: string }[], message: { one: string; many: (count: number) => string }): PartialFailure[] {
  if (mods.length === 0) return [];
  return [{ message: mods.length === 1 ? message.one : message.many(mods.length), detail: mods.map(({ mod }) => `"${mod}"`).join(', '), severity: 'warning' }];
}

function refusedInMods(outcome: BuildOutcome): PartialFailure[] {
  return outcome.landed.flatMap(({ mod, refused, archivesRefused }) => [
    ...refused.map(({ item, reason }) => ({ message: `Could not build "${pluginRowName(item)}" in "${mod}".`, detail: reason, severity: 'log' as const })),
    ...archivesRefused.map(({ item, reason, unpacking }) => ({ message: `Could not ${unpacking === true ? 'unpack' : 'pack'} "${item}" in "${mod}".`, detail: reason, severity: 'log' as const })),
  ]);
}

function inMod(path: string, mod: string): string {
  return `${path} (${mod})`;
}
