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
import { initProgressMessage } from './initProgress';
import type { PluginsTreeNode } from './pluginRows';
import { PLUGINS_KEY_ARGS } from './gestureEntry';
import { gestureEntry, isClickedRow, selectionArgument } from '../drivingLib/gestureEntry';
import type { ItemRefusal, SelectionOutcome } from '../ports/selectionOutcome';
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

export interface InitDeps {
  progress: Pick<PluginsViewProgress, 'say'>;
  instance: Pick<Instance, 'refresh'>;
  commands: Pick<SourceCommands, 'init'>;
  reporter: Reporter;
  onInitialized: () => Promise<void>;
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

/** commands.md, `init`: the mods of Mods rows, plugin rows, a column header, or the palette's
 *  selection, in one call. A plugin no mod provides is refused here, since mEdit is sent mods. */
export function registerInitCommand(deps: InitDeps, paletteSelection: () => readonly unknown[]): vscode.Disposable {
  return vscode.commands.registerCommand(
    'modbench.mod.init',
    async (clicked?: unknown, selected?: readonly unknown[]) => {
      const rows = gestureEntry(clicked, selected, paletteSelection, isClickedRow).selection;
      const invokedFrom = rows.some((row) => modArgumentOf(row) !== undefined) ? deps.modsView : PLUGINS_KEY_ARGS.view;
      await initMods(deps, targetsOf(rows, deps.modDirs()), invokedFrom);
    },
  );
}

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
async function initMods(deps: InitDeps, { mods, refusedRows }: ModTargets, invokedFrom: string): Promise<void> {
  const { progress, instance, commands, reporter, onInitialized } = deps;
  const [firstMod] = mods;
  if (firstMod === undefined) {
    if (refusedRows.length > 0) reportRefused(reporter, 0, { refused: [], plugins: [], refusedPlugins: refusedRows });
    return;
  }
  const what = mods.length === 1 ? `"${firstMod}"` : `${mods.length} mods`;

  await runWritingGesture(invokedFrom, instance, async () => {
    try {
      progress.say(initProgressMessage(firstMod, { phase: 'Idle', pluginsDone: 0, pluginsTotal: 0 }));
      const result = await commands.init(mods, {
        onProgress: (status) => { progress.say(initProgressMessage(status.mod ?? firstMod, status)); },
      });
      if (isRefused(result)) { reporter.report('error', result.message); return; }
      if (result.landed.length > 0) await onInitialized();
      const outcome = {
        refused: result.refused,
        plugins: result.landed.flatMap((landed) => landed.plugins),
        refusedPlugins: refusedRows,
      };
      if (outcome.refused.length + outcome.refusedPlugins.length > 0) reportRefused(reporter, mods.length, outcome);
      else if (result.landed.length > 0) reporter.landed(`Initialized ${what}.`);
    } finally {
      progress.say(undefined);
    }
  });
}

interface InitReport {
  refused: InitOutcome['refused'];
  plugins: readonly PluginAddress[];
  refusedPlugins: readonly ItemRefusal<string>[];
}

// commands.md, "each item lands on its own": one notification naming each refused mod and each
// refused plugin.
function reportRefused(reporter: Reporter, modCount: number, report: InitReport): void {
  const counts = [
    ...(report.refused.length > 0 ? [`${report.refused.length} of ${modCount} mods`] : []),
    ...(report.refusedPlugins.length > 0
      ? [`${report.refusedPlugins.length} of ${report.plugins.length + report.refusedPlugins.length} plugins`]
      : []),
  ];
  reporter.selectionOutcome(`Could not init ${counts.join(' and ')}.`, {
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
  return vscode.commands.registerCommand(
    'modbench.plugin.decompile',
    async (clicked?: unknown, selected?: readonly PluginsTreeNode[]) => {
      const header = columnHeaderOf(clicked);
      const plugins = header
        ? [header]
        : selectionArgument(gestureEntry(clicked, selected, viewSelection), 'plugin').map((node) => node.argument.plugin);
      if (plugins.length === 0 || !(await confirmDecompile(deps.ask, plugins))) return;
      await runWritingGesture(PLUGINS_KEY_ARGS.view, deps.instance, async () => {
        const outcome = await deps.client.decompile(plugins);
        if (isRefused(outcome)) { deps.reporter.report('error', outcome.message); return; }
        reportDecompiled(deps.reporter, outcome, plugins.length);
      });
    },
  );
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
  /** The mods that hold a repository. */
  sourceMods: () => ReadonlySet<string>;
  /** The Mods view's id, whose bar a gesture from a Mods row or the palette runs under. */
  modsView: string;
}

const NOT_A_SOURCE_MOD = 'it is not a source mod';

/** commands.md, `build`: the mods of Mods rows, plugin rows, a column header, the palette's
 *  selection, or the palette's pick of every source mod, built from the working tree. */
export function registerBuildCommand(deps: BuildDeps, paletteSelection: () => readonly unknown[]): vscode.Disposable {
  return vscode.commands.registerCommand(
    'modbench.mod.build',
    async (clicked?: unknown, selected?: readonly unknown[]) => {
      const entry = gestureEntry(clicked, selected, paletteSelection, isClickedRow);
      const targets = targetsOf(entry.selection, deps.modDirs());
      const fromARow = entry.clicked !== undefined || targets.mods.some((mod) => deps.sourceMods().has(mod));
      if (fromARow) {
        const invokedFrom = entry.selection.some((row) => modArgumentOf(row) !== undefined) ? deps.modsView : PLUGINS_KEY_ARGS.view;
        await buildMods(deps, targets, invokedFrom);
        return;
      }
      const mods = await pickSourceMods(deps.sourceMods());
      if (mods !== undefined) await buildMods(deps, { mods, refusedRows: [] }, deps.modsView);
    },
  );
}

// mods.md, Build, story 7: from the palette with no source mod selected, a pick of every source.
async function pickSourceMods(sourceMods: ReadonlySet<string>): Promise<string[] | undefined> {
  const items = [...sourceMods].sort().map((label) => ({ label }));
  const picked = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: 'Build which mods?' });
  return picked?.map((item) => item.label);
}

async function buildMods(deps: BuildDeps, targets: ModTargets, invokedFrom: string): Promise<void> {
  const { reporter, commands, instance } = deps;
  const sourceMods = deps.sourceMods();
  const mods = targets.mods.filter((mod) => sourceMods.has(mod));
  const refusedRows = [
    ...targets.refusedRows,
    ...targets.mods.filter((mod) => !sourceMods.has(mod)).map((mod) => ({ item: mod, reason: NOT_A_SOURCE_MOD })),
  ];
  if (mods.length === 0) {
    if (refusedRows.length > 0) reportBuilt(reporter, { landed: [], refused: refusedRows });
    return;
  }
  if (!(await savedFirst(deps, mods))) return;
  await runWritingGesture(invokedFrom, instance, async () => {
    const outcome = await commands.build(mods, deps.gameRelease());
    if (isRefused(outcome)) { reporter.report('error', outcome.message); return; }
    for (const { compiled } of outcome.landed) {
      for (const plugin of compiled) deps.problems.publish(plugin, deps.sourceFiles(plugin.origin), plugin.diagnostics);
    }
    reportBuilt(reporter, { landed: outcome.landed, refused: [...outcome.refused, ...refusedRows] });
    reportOverwritten(reporter, outcome);
  });
}

// mods.md, Build, story 5: the plugins are built from what the user sees, so the mod's unsaved
// plugin source is saved first, and a file VS Code does not save refuses the build before anything
// is written.
async function savedFirst(deps: BuildDeps, mods: readonly string[]): Promise<boolean> {
  const unsaved: string[] = [];
  const homeless: string[] = [];
  for (const mod of mods) {
    const left = await deps.saveUnsaved(mod);
    if (left === undefined) homeless.push(mod);
    else unsaved.push(...left);
  }
  if (homeless.length > 0) {
    deps.reporter.report('error', 'Could not build: no source folder for these mods.', homeless.join('\n'));
    return false;
  }
  if (unsaved.length === 0) return true;
  deps.reporter.report('error', 'Could not build: VS Code did not save its plugin source.', unsaved.join('\n'));
  return false;
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

// mods.md, A source mod, story 4: a file the build overwrote is named, whatever else the build did.
function reportOverwritten(reporter: Reporter, outcome: BuildOutcome): void {
  const overwritten = outcome.landed.flatMap(({ mod, overwritten: paths }) => paths.map((path) => inMod(path, mod)));
  if (overwritten.length === 0) return;
  reporter.report(
    'warning',
    `Build overwrote ${overwritten.length} ${overwritten.length === 1 ? 'file' : 'files'} that differed.`,
    overwritten.map((name) => `"${name}"`).join(', '),
  );
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
