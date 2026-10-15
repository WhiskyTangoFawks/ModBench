import * as vscode from 'vscode';
import {
  isRefused, type MEditClient, type CompileDiagnostic, type BuildOutcome, type PluginAddress, type InitOutcome,
} from '../client';
import type { SourceFiles, SourceFilesOf } from '../instanceLoader/loadOrderSnapshot';
import type { Instance } from '../instanceLoader/instance';
import { runWritingGesture } from '../drivingLib/writingGesture';
import { modArgumentOf, pluginArgumentOf, rowNameOf } from '../drivingLib/argument';
import { recordArgumentOf } from '../drivingLib/recordArgument';
import { modOfOrigin } from '../instanceLoader/modOfOrigin';
import { pluginAddressKey } from '../wire/pluginAddress';
import { decompileAndCommitProgressMessage } from './decompileAndCommitProgress';
import type { PluginsTreeNode } from './pluginRows';
import { PLUGINS_KEY_ARGS, pluginOf } from './gestureEntry';
import { argumentOfKind, registerAgentGesture, reportPartial, type AgentGesture, type GestureResult, type PartialFailure } from '../drivingLib/agentGesture';
import type { SelectionResult } from '../pluginsCommands/plugins';
import { isClickedRow, selectionArgument } from '../drivingLib/gestureEntry';
import type { ItemRefusal, SelectionOutcome } from '../ports/selectionOutcome';
import type { Argument } from '../wire/argument';
import type { Reporter } from '../ports/reporter';
import type { SourceCommands } from '../sourceCommands/sourceCommands';
import type { AskQuestion } from '../ports/dialog';

/** The Plugins tree's one progress surface (plugins.md, States, story 2): a spinner over the
 *  view while the work runs, and the view's own message line. */
export interface PluginsViewProgress {
  /** Runs `work` under the spinner, clearing the message on every exit path. */
  while: (work: () => Promise<void>) => Promise<void>;
  /** `undefined` gives the line back to whatever else had something to say. */
  say: (message: string | undefined) => void;
}

// ADR-0012.
function rowName(row: PluginAddress): string {
  return `${row.name} (${row.origin})`;
}

export interface DecompileAndCommitDeps {
  progress: Pick<PluginsViewProgress, 'say'>;
  instance: Pick<Instance, 'refresh'>;
  commands: Pick<SourceCommands, 'decompileAndCommit'>;
  reporter: Reporter;
  onCommitted: () => Promise<void>;
  /** The instance's mod folders by mod name, which say whether an origin is a mod. */
  modDirs: () => ReadonlyMap<string, string>;
  /** The Mods view's id, whose bar a gesture from a Mods row runs under. */
  modsView: string;
}

interface ModTargets {
  mods: readonly string[];
  /** Rows named with why they were not sent: a plugin no mod provides, such as Overwrite's or the game's own, or a row that carries no mod or plugin. */
  refusedRows: readonly ItemRefusal<string>[];
}

const NOT_IN_A_MOD = 'it is not in a mod';
const NO_MOD_OR_PLUGIN = 'it carries no mod or plugin';

interface ModsGiven {
  readonly mods: readonly string[];
  /** What a view call was given that names no mod to send, and why. */
  readonly refusedRows: readonly ItemRefusal<string>[];
  readonly invokedFrom: string;
}

type DecompiledAndCommitted = GestureResult<InitOutcome['landed'][number], string>;

/** commands.md, `decompile and commit`: the mods of Mods rows, plugin rows, a column header, or the palette's
 *  selection, in one call. A plugin no mod provides is refused here, since mEdit is sent mods. */
export function registerDecompileAndCommitCommand(deps: DecompileAndCommitDeps, paletteSelection: () => readonly unknown[]): vscode.Disposable {
  const gesture: AgentGesture<unknown, ModsGiven, DecompiledAndCommitted> = {
    fromView: (entry) => ({ ...targetsOf(entry.selection, deps.modDirs()), invokedFrom: viewOf(entry.selection, deps.modsView) }),
    fromAgent: ({ argument }) => givenByAgent(argument, deps.modsView),
    run: ({ mods, invokedFrom }) => decompileAndCommitMods(deps, mods, invokedFrom),
    report: (result, { mods, refusedRows }) => reportDecompiledAndCommitted(deps.reporter, result, mods, refusedRows),
  };
  return registerAgentGesture('modbench.mod.decompileAndCommit', paletteSelection, gesture, isClickedRow);
}

const givenByAgent = (argument: readonly Argument[], invokedFrom: string): ModsGiven =>
  ({ mods: argument.map((mod) => argumentOfKind(mod, 'mod').name), refusedRows: [], invokedFrom });

const viewOf = (rows: readonly unknown[], modsView: string): string =>
  (rows.some((row) => modArgumentOf(row) !== undefined) ? modsView : PLUGINS_KEY_ARGS.view);

function targetsOf(rows: readonly unknown[], modDirs: ReadonlyMap<string, string>): ModTargets {
  const mods = new Set<string>();
  const refusedRows: ItemRefusal<string>[] = [];
  for (const row of rows) {
    const mod = modArgumentOf(row);
    if (mod !== undefined) { mods.add(mod.name); continue; }
    const plugin = pluginAddressOf(row);
    if (plugin === undefined) { refusedRows.push({ item: rowNameOf(row), reason: NO_MOD_OR_PLUGIN }); continue; }
    const owner = modOfOrigin(modDirs, plugin.origin);
    if (owner === undefined) refusedRows.push({ item: rowName(plugin), reason: NOT_IN_A_MOD }); else mods.add(owner);
  }
  return { mods: [...mods], refusedRows };
}

// A plugin row or a column header acts on its plugin's mod.
function pluginAddressOf(row: unknown): PluginAddress | undefined {
  return pluginArgumentOf(row)?.plugin ?? columnHeaderOf(row);
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

/** What decompile needs: the call, the Instance loader's refresh, its one confirmation, and how the user
 *  is told. */
export interface DecompileDeps {
  client: Pick<MEditClient, 'decompile'>;
  instance: Pick<Instance, 'refresh'>;
  reporter: Reporter;
  ask: AskQuestion;
}

/** commands.md, `decompile`: the plugins of Plugins rows, the selection included, of a record tab's
 *  column header, or of the palette's Plugins selection, asked once. */
export function registerDecompileCommand(
  deps: DecompileDeps, viewSelection: () => readonly PluginsTreeNode[],
): vscode.Disposable {
  const gesture: AgentGesture<PluginsTreeNode, readonly PluginAddress[], SelectionResult<PluginAddress>> = {
    fromView: async (entry, _option, clicked) => {
      const header = columnHeaderOf(clicked);
      const plugins = header ? [header] : selectionArgument(entry, 'plugin').map((node) => node.argument.plugin);
      return plugins.length > 0 && await confirmDecompile(deps.ask, plugins) ? plugins : undefined;
    },
    fromAgent: ({ argument }) => argument.map(pluginOf),
    run: (plugins) => runWritingGesture(PLUGINS_KEY_ARGS.view, deps.instance, async () => {
      const outcome = await deps.client.decompile(plugins);
      return isRefused(outcome) ? { applied: false, refusal: outcome.message } : { applied: true, outcome };
    }),
    report: (result, plugins) => {
      if (result.applied) reportDecompiled(deps.reporter, result.outcome, plugins.length);
      else deps.reporter.report('error', result.refusal);
    },
  };
  return registerAgentGesture('modbench.plugin.decompile', viewSelection, gesture);
}

// plugins.md, Decompile: one confirmation for the selection, naming the plugins; it replaces
// what the working tree holds (commands.md, Confirm what destroys).
async function confirmDecompile(ask: AskQuestion, plugins: readonly PluginAddress[]): Promise<boolean> {
  const [only] = plugins;
  const answer = plugins.length === 1 && only !== undefined
    ? await ask(`Decompile "${only.name}" in ${only.origin}? Decompile replaces its source in the working tree from its bytes.`,
      { modal: true }, 'Decompile')
    : await ask(`Decompile ${plugins.length} plugins? Decompile replaces their source in the working tree from their bytes.`,
      { modal: true, detail: plugins.map(rowName).join('\n') }, 'Decompile');
  return answer === 'Decompile';
}

function reportDecompiled(reporter: Reporter, outcome: SelectionOutcome<PluginAddress>, total: number): void {
  const [refused] = outcome.refused;
  if (refused !== undefined) {
    const what = total === 1 ? `"${refused.item.name}"` : `${outcome.refused.length} of ${total} plugins`;
    reporter.selectionOutcome(`Could not decompile ${what}.`, outcome, rowName);
    return;
  }
  const [only, ...more] = outcome.landed;
  if (only === undefined) return;
  reporter.landed(more.length === 0 ? `Decompiled "${only.name}".` : `Decompiled ${outcome.landed.length} plugins.`);
}

/** What build needs: the build itself, the Instance loader's refresh, where the diagnostics go, and
 *  how the user is told. */
export interface BuildDeps {
  commands: Pick<SourceCommands, 'build'>;
  instance: Pick<Instance, 'refresh'>;
  /** The instance's release, which says what its archives pack as. */
  gameRelease: () => string | undefined;
  reporter: Reporter;
  problems: BuildProblems;
  sourceFiles: SourceFilesOf;
  /** Saves the mod's unsaved plugin source; answers the paths VS Code left unsaved, or undefined when the mod has no source folder. */
  saveUnsaved: (mod: string) => Promise<string[] | undefined>;
  /** The instance's mod folders by mod name, which say whether an origin is a mod. */
  modDirs: () => ReadonlyMap<string, string>;
  /** The source folder of each mod that holds a repository, by mod name. */
  sourceDirs: () => ReadonlyMap<string, string>;
  /** The Mods view's id, whose bar a gesture from a Mods row or the palette runs under. */
  modsView: string;
}

const NOT_A_SOURCE_MOD = 'it is not a source mod';

type Built = GestureResult<BuildOutcome['landed'][number], string>;

/** commands.md, `build`: the mods of Mods rows, plugin rows, a column header, the palette's
 *  selection, or the palette's pick of every source mod, built from the working tree. */
export function registerBuildCommand(deps: BuildDeps, paletteSelection: () => readonly unknown[]): vscode.Disposable {
  const gesture: AgentGesture<unknown, ModsGiven, Built> = {
    fromView: async (entry) => {
      const targets = targetsOf(entry.selection, deps.modDirs());
      const fromARow = entry.clicked !== undefined || targets.mods.some((mod) => deps.sourceDirs().has(mod));
      if (fromARow) return { ...targets, invokedFrom: viewOf(entry.selection, deps.modsView) };
      const mods = await pickSourceMods(deps.sourceDirs());
      return mods === undefined ? undefined : { mods, refusedRows: [], invokedFrom: deps.modsView };
    },
    fromAgent: ({ argument }) => givenByAgent(argument, deps.modsView),
    run: (given) => buildMods(deps, given),
    report: (result) => reportBuildResult(deps.reporter, result),
  };
  return registerAgentGesture('modbench.mod.build', paletteSelection, gesture, isClickedRow);
}

// mods.md, Build, story 7: from the palette with no source mod selected, a pick of every source.
async function pickSourceMods(sourceDirs: ReadonlyMap<string, string>): Promise<string[] | undefined> {
  const items = [...sourceDirs.keys()].sort().map((label) => ({ label }));
  const picked = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: 'Build which mods?' });
  return picked?.map((item) => item.label);
}

async function buildMods(deps: BuildDeps, { mods: named, refusedRows, invokedFrom }: ModsGiven): Promise<Built> {
  const { commands, instance } = deps;
  const sourceDirs = deps.sourceDirs();
  const mods = named.filter((mod) => sourceDirs.has(mod));
  const notSource = named.filter((mod) => !sourceDirs.has(mod)).map((mod) => ({ item: mod, reason: NOT_A_SOURCE_MOD }));
  if (mods.length === 0) return { applied: true, outcome: { landed: [], refused: [...refusedRows, ...notSource] } };
  const unsaved = await savedFirst(deps, mods);
  if (unsaved !== undefined) return unsaved;
  return runWritingGesture(invokedFrom, instance, async (): Promise<Built> => {
    const outcome = await commands.build(mods, deps.gameRelease(), sourceDirs);
    if (isRefused(outcome)) return { applied: false, refusal: outcome.message };
    for (const { compiled } of outcome.landed) {
      for (const plugin of compiled) deps.problems.publish(plugin, deps.sourceFiles(plugin.origin), plugin.diagnostics);
    }
    return {
      applied: true,
      outcome: { landed: outcome.landed, refused: [...outcome.refused, ...refusedRows, ...notSource] },
      partial: [...partlyBuilt(outcome), ...overwritten(outcome), ...builtUncommitted(outcome), ...refusedInMods(outcome)],
    };
  });
}

function reportBuildResult(reporter: Reporter, result: Built): void {
  if (!result.applied) { reporter.report('error', result.refusal, result.detail); return; }
  reportBuilt(reporter, result.outcome);
  reportPartial(reporter, result.partial);
}

// mods.md, Build, story 5: the plugins are built from what the user sees, so the mod's unsaved
// plugin source is saved first, and a file VS Code does not save refuses the build before anything
// is written.
async function savedFirst(deps: BuildDeps, mods: readonly string[]): Promise<Built | undefined> {
  const unsaved: string[] = [];
  const homeless: string[] = [];
  for (const mod of mods) {
    const left = await deps.saveUnsaved(mod);
    if (left === undefined) homeless.push(mod);
    else unsaved.push(...left);
  }
  if (homeless.length > 0) return { applied: false, refusal: 'Could not build: no source folder for these mods.', detail: homeless.join('\n') };
  if (unsaved.length === 0) return undefined;
  return { applied: false, refusal: 'Could not build: VS Code did not save its plugin source.', detail: unsaved.join('\n') };
}

function diagnosticsWords(count: number): string {
  return `${count} ${count === 1 ? 'diagnostic' : 'diagnostics'}. See the Problems panel.`;
}

// mods.md, Build, story 6, and common.md, Reporting: one notification when it lands, naming each
// refused mod and plugin and why, and pointing at the Problems panel when it left diagnostics.
function reportBuilt(reporter: Reporter, outcome: BuildOutcome): void {
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
      refused: [...outcome.refused, ...refusedPlugins.map(({ item, reason }) => ({ item: rowName(item), reason })), ...refusedArchives],
    }, (name) => name);
    return;
  }
  const [only, ...more] = outcome.landed;
  if (only === undefined) return;
  const what = more.length === 0 ? `"${only.mod}"` : `${outcome.landed.length} mods`;
  reporter.landed(diagnostics > 0 ? `Built ${what} with ${diagnosticsWords(diagnostics)}` : `Built ${what}.`);
}

// common.md, Reporting: a mod whose build stopped after it began writing landed, and the part that failed is named.
function partlyBuilt(outcome: BuildOutcome): PartialFailure[] {
  const partly = outcome.landed.flatMap(({ mod, failure }) => (failure === undefined ? [] : [`"${mod}" (${failure})`]));
  return partly.length === 0 ? [] : [{
    message: `Built ${partly.length} mod${partly.length === 1 ? '' : 's'} only in part.`, detail: partly.join(', '), severity: 'warning',
  }];
}

// mods.md, A source mod, story 4: a file the build overwrote is named, whatever else the build did.
function overwritten(outcome: BuildOutcome): PartialFailure[] {
  const paths = outcome.landed.flatMap(({ mod, overwritten: files }) => files.map((path) => inMod(path, mod)));
  return paths.length === 0 ? [] : [{
    message: `Build overwrote ${paths.length} ${paths.length === 1 ? 'file' : 'files'} that differed.`,
    detail: paths.map((name) => `"${name}"`).join(', '), severity: 'warning',
  }];
}

// mods.md, Build, story 1: the manifest names a commit, so a build from changes no commit holds says so.
function builtUncommitted(outcome: BuildOutcome): PartialFailure[] {
  const mods = outcome.landed.filter(({ uncommitted }) => uncommitted === true).map(({ mod }) => `"${mod}"`);
  return mods.length === 0 ? [] : [{
    message: `Built ${mods.length === 1 ? '1 mod' : `${mods.length} mods`} from changes no commit holds, so ${mods.length === 1 ? 'its' : 'their'} `
      + `manifest's commit does not rebuild ${mods.length === 1 ? 'it' : 'them'}.`,
    detail: mods.join(', '), severity: 'warning',
  }];
}

function refusedInMods(outcome: BuildOutcome): PartialFailure[] {
  return outcome.landed.flatMap(({ mod, refused, archivesRefused }) => [
    ...refused.map(({ item, reason }) => ({ message: `Could not build "${rowName(item)}" in "${mod}".`, detail: reason, severity: 'log' as const })),
    ...archivesRefused.map(({ item, reason }) => ({ message: `Could not pack "${item}" in "${mod}".`, detail: reason, severity: 'log' as const })),
  ]);
}

function inMod(path: string, mod: string): string {
  return `${path} (${mod})`;
}

/** The build's diagnostics in the Problems panel. A build replaces those of each plugin it compiled
 *  and no other plugin's, so one refused beside it in its mod keeps what its last build found. */
export class BuildProblems {
  private readonly published = new Map<string, vscode.Uri[]>();

  constructor(private readonly collection: vscode.DiagnosticCollection) {}

  dispose(): void {
    this.collection.dispose();
  }

  publish(plugin: PluginAddress, files: SourceFiles | undefined, diagnostics: readonly CompileDiagnostic[]): void {
    const key = pluginAddressKey(plugin);
    for (const uri of this.published.get(key) ?? []) this.collection.delete(uri);
    if (files === undefined) {
      this.published.delete(key);
      return;
    }

    const byPath = new Map<string, vscode.Diagnostic[]>();
    for (const d of diagnostics) {
      const fsPath = files.file(d.sourceRelativePath);
      const list = byPath.get(fsPath) ?? [];
      list.push(new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), d.message, vscode.DiagnosticSeverity.Warning));
      byPath.set(fsPath, list);
    }
    const uris = [...byPath].map(([fsPath, list]) => {
      const uri = vscode.Uri.file(fsPath);
      this.collection.set(uri, list);
      return uri;
    });
    this.published.set(key, uris);
  }
}

// A record tab's column header carries its record's Argument, whose plugin the gesture acts on (editor.md, Menus and keys).
function columnHeaderOf(value: unknown): PluginAddress | undefined {
  return typeof value === 'object' && value !== null && Reflect.get(value, 'webviewSection') === 'recordHeader'
    ? recordArgumentOf(value)?.plugin : undefined;
}
