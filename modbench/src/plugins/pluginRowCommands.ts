import * as vscode from 'vscode';
import {
  isRefused, type MEditClient, type CompileDiagnostic, type CompileOutcome, type PluginAddress, type TrackOutcome,
} from '../client';
import type { OriginFiles, OriginFilesOf } from '../instanceLoader/loadOrderSnapshot';
import type { Instance } from '../instanceLoader/instance';
import { runWritingGesture } from '../drivingLib/writingGesture';
import { modOfRow } from '../drivingLib/modRow';
import { modOfOrigin } from './modOfOrigin';
import { pluginAddressKey } from './pluginAddress';
import { trackProgressMessage } from './trackProgress';
import { PluginNode, type PluginsTreeNode } from './PluginsTreeProvider';
import { pickWithMarked } from '../drivingLib/pickWithMarked';
import { compilableSelected, PLUGINS_KEY_ARGS } from './gestureEntry';
import { gestureEntry, selectionArgument, type GestureEntry } from '../drivingLib/gestureEntry';
import type { ItemRefusal, SelectionOutcome } from '../ports/selectionOutcome';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import { errorMessage } from '../ports/errorMessage';

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

export interface TrackDeps {
  progress: Pick<PluginsViewProgress, 'say'>;
  instance: Pick<Instance, 'refresh'>;
  client: Pick<MEditClient, 'track'>;
  reporter: Reporter;
  onTracked: () => Promise<void>;
  /** The instance's mod folders by mod name, which say whether an origin is a mod. */
  modDirs: () => ReadonlyMap<string, string>;
  /** The Mods view's id, whose bar a gesture from a Mods row runs under. */
  modsView: string;
}

interface TrackTargets {
  mods: readonly string[];
  /** Plugins no mod provides, such as Overwrite's or the game's own. */
  notInMod: readonly PluginAddress[];
}

const NOT_IN_A_MOD = 'it is not in a mod';

/** commands.md, `track`: the mods of Mods rows, plugin rows, a column header, or the palette's
 *  selection, in one call. A plugin no mod provides is refused here, since mEdit is sent mods. */
export function registerTrackCommand(deps: TrackDeps, paletteSelection: () => readonly unknown[]): vscode.Disposable {
  return vscode.commands.registerCommand(
    'modbench.mod.track',
    async (clicked?: unknown, selected?: readonly unknown[]) => {
      const rows = clicked === undefined ? paletteSelection() : selected ?? [clicked];
      const invokedFrom = rows.some((row) => modOfRow(row) !== undefined) ? deps.modsView : PLUGINS_KEY_ARGS.view;
      await trackMods(deps, targetsOf(rows, deps.modDirs()), invokedFrom);
    },
  );
}

function targetsOf(rows: readonly unknown[], modDirs: ReadonlyMap<string, string>): TrackTargets {
  const mods = new Set<string>();
  const notInMod: PluginAddress[] = [];
  for (const row of rows) {
    const mod = modOfRow(row);
    if (mod !== undefined) { mods.add(mod); continue; }
    const plugin = pluginAddressOf(row);
    if (plugin === undefined) continue;
    const owner = modOfOrigin(modDirs, plugin.origin);
    if (owner === undefined) notInMod.push(plugin); else mods.add(owner);
  }
  return { mods: [...mods], notInMod };
}

// A plugin row or a column header acts on its plugin's mod.
function pluginAddressOf(row: unknown): PluginAddress | undefined {
  return row instanceof PluginNode ? { name: row.plugin.name, origin: row.origin } : columnHeaderOf(row);
}

// A mega-plugin's serialization is a one-time, worst-case tens-of-seconds cost, so this runs
// under the Plugins-view progress indicator.
async function trackMods(deps: TrackDeps, { mods, notInMod }: TrackTargets, invokedFrom: string): Promise<void> {
  const { progress, instance, client, reporter, onTracked } = deps;
  const refusedHere = notInMod.map((item) => ({ item, reason: NOT_IN_A_MOD }));
  const [firstMod] = mods;
  if (firstMod === undefined) {
    if (refusedHere.length > 0) reportRefused(reporter, 0, { refused: [], tracked: [], refusedPlugins: refusedHere });
    return;
  }
  const what = mods.length === 1 ? `"${firstMod}"` : `${mods.length} mods`;

  await runWritingGesture(invokedFrom, instance, async () => {
    try {
      progress.say(trackProgressMessage(firstMod, { phase: 'Idle', pluginsDone: 0, pluginsTotal: 0 }));
      const result = await client.track(mods, {
        onProgress: (status) => { progress.say(trackProgressMessage(status.mod ?? firstMod, status)); },
      });
      if (isRefused(result)) { reporter.report('error', result.message); return; }
      if (result.landed.length > 0) await onTracked();
      const outcome = {
        refused: result.refused,
        tracked: result.landed.flatMap((landed) => landed.tracked),
        refusedPlugins: [...refusedHere, ...result.landed.flatMap((landed) => landed.refused)],
      };
      if (outcome.refused.length + outcome.refusedPlugins.length > 0) reportRefused(reporter, mods.length, outcome);
      else if (result.landed.length > 0) reporter.landed(`Tracked ${what}.`);
    } finally {
      progress.say(undefined);
    }
  });
}

interface TrackReport {
  refused: TrackOutcome['refused'];
  tracked: readonly PluginAddress[];
  refusedPlugins: readonly ItemRefusal<PluginAddress>[];
}

// commands.md, "each item lands on its own": one notification naming each refused mod and each
// refused plugin.
function reportRefused(reporter: Reporter, modCount: number, report: TrackReport): void {
  const counts = [
    ...(report.refused.length > 0 ? [`${report.refused.length} of ${modCount} mods`] : []),
    ...(report.refusedPlugins.length > 0
      ? [`${report.refusedPlugins.length} of ${report.tracked.length + report.refusedPlugins.length} plugins`]
      : []),
  ];
  reporter.selectionOutcome(`Could not track ${counts.join(' and ')}.`, {
    landed: report.tracked.map(rowName),
    refused: [
      ...report.refusedPlugins.map(({ item, reason }) => ({ item: rowName(item), reason })),
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
        : selectionArgument(gestureEntry(clicked, selected, viewSelection), 'plugin')
          .map((node) => ({ name: node.plugin.name, origin: node.origin }));
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

/** What compile needs: the tracked plugins for the palette's pick, the compile itself, the
 *  Instance loader's refresh, where the diagnostics go, and how the user is told. */
export interface CompileDeps {
  client: Pick<MEditClient, 'getPlugins' | 'compile'>;
  instance: Pick<Instance, 'refresh'>;
  reporter: Reporter;
  problems: CompileProblems;
  originFiles: OriginFilesOf;
}

/** commands.md, `compile`: the plugins, the selection included, from a Plugins row, a record tab's
 *  column header, or the palette's pick, built from the working tree. */
export function registerCompileCommand(
  deps: CompileDeps, viewSelection: () => readonly PluginsTreeNode[],
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'modbench.plugin.compile',
    async (clicked?: unknown, selected?: readonly PluginsTreeNode[]) => {
      const plugins = await argumentOf(deps, clicked, selected, viewSelection);
      if (plugins !== undefined) await compilePlugins(deps, plugins);
    },
  );
}

async function argumentOf(
  deps: CompileDeps, clicked: unknown, selected: readonly PluginsTreeNode[] | undefined,
  viewSelection: () => readonly PluginsTreeNode[],
): Promise<PluginAddress[] | undefined> {
  const header = columnHeaderOf(clicked);
  if (header) return [header];
  const entry = gestureEntry(clicked, selected, viewSelection);
  if (entry.clicked === undefined) return pickCompilable(deps, entry);
  return selectionArgument(entry, 'plugin').map((node) => ({ name: node.plugin.name, origin: node.origin }));
}

// plugins.md, Compile, story 3: from the palette, a pick of the tracked, editable plugins. An
// extension cannot tell whether the Plugins view has focus, so it always asks, a selected
// compilable plugin first and marked.
async function pickCompilable(deps: CompileDeps, entry: GestureEntry<PluginsTreeNode>): Promise<PluginAddress[] | undefined> {
  const selected = compilableSelected(entry.selection);
  const selectedKey = selected && pluginAddressKey(selected.plugin.name, selected.origin);
  const isSelected = (item: { label: string; description: string }) => pluginAddressKey(item.label, item.description) === selectedKey;
  const plugins = await deps.client.getPlugins().catch((err: unknown) => {
    deps.reporter.report('error', 'Could not list the plugins to compile.', errorMessage(err));
    return undefined;
  });
  if (plugins === undefined) return undefined;
  const items = plugins
    .filter((p) => p.isTracked)
    .map((p) => ({ label: p.name, description: p.origin }))
    .sort((a, b) => Number(isSelected(b)) - Number(isSelected(a)));
  const choice = await pickWithMarked(items, items.find(isSelected), 'Compile which plugin?');
  return choice && [{ name: choice.label, origin: choice.description }];
}

// Reported once when it lands. Nothing re-reads `GET /plugins` after it: a compiled binary changes
// only bytes on disk, which the index's own mirror watch re-reads.
async function compilePlugins(deps: CompileDeps, plugins: readonly PluginAddress[]): Promise<void> {
  if (plugins.length === 0) return;
  await runWritingGesture(PLUGINS_KEY_ARGS.view, deps.instance, async () => {
    const outcome = await deps.client.compile(plugins);
    if (isRefused(outcome)) { deps.reporter.report('error', outcome.message); return; }
    publishLanded(deps, outcome);
    reportCompiled(deps.reporter, outcome, plugins.length);
  });
}

function publishLanded(deps: CompileDeps, outcome: CompileOutcome): void {
  for (const compiled of outcome.landed) deps.problems.publish(compiled, deps.originFiles(compiled.origin), compiled.diagnostics);
}

function diagnosticsWords(count: number): string {
  return `${count} ${count === 1 ? 'diagnostic' : 'diagnostics'}. See the Problems panel.`;
}

// plugins.md, Compile, story 2, and Reporting: one notification when it lands, naming each refused
// plugin and why, and pointing at the Problems panel when it left diagnostics.
function reportCompiled(reporter: Reporter, outcome: CompileOutcome, total: number): void {
  const diagnostics = outcome.landed.reduce((sum, compiled) => sum + compiled.diagnostics.length, 0);
  const [refused] = outcome.refused;
  if (refused !== undefined) {
    const rest = diagnostics > 0 ? ` The rest compiled with ${diagnosticsWords(diagnostics)}` : '';
    const what = total === 1 ? `"${refused.item.name}"` : `${outcome.refused.length} of ${total} plugins`;
    reporter.selectionOutcome(
      `Could not compile ${what}.${rest}`,
      { landed: outcome.landed, refused: outcome.refused }, rowName);
    return;
  }
  const [only, ...more] = outcome.landed;
  if (only === undefined) return;
  const what = more.length === 0 ? `"${only.name}"` : `${outcome.landed.length} plugins`;
  reporter.landed(diagnostics > 0 ? `Compiled ${what} with ${diagnosticsWords(diagnostics)}` : `Compiled ${what}.`);
}

/** The compile diagnostics in the Problems panel. A plugin's compile replaces its own and no other
 *  plugin's, so one refused beside it in its mod keeps what its last compile found. */
export class CompileProblems {
  private readonly published = new Map<string, vscode.Uri[]>();

  constructor(private readonly collection: vscode.DiagnosticCollection) {}

  publish(plugin: PluginAddress, files: OriginFiles | undefined, diagnostics: readonly CompileDiagnostic[]): void {
    const key = pluginAddressKey(plugin.name, plugin.origin);
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

// A record tab's column header names its plugin and origin (editor.md, Menus and keys).
function columnHeaderOf(value: unknown): { name: string; origin: string } | undefined {
  if (typeof value !== 'object' || value === null || Reflect.get(value, 'webviewSection') !== 'recordHeader') return undefined;
  const name: unknown = Reflect.get(value, 'plugin');
  const origin: unknown = Reflect.get(value, 'origin');
  return typeof name === 'string' && typeof origin === 'string' ? { name, origin } : undefined;
}
