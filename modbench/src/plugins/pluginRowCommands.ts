import * as vscode from 'vscode';
import {
  isRefused, type MEditClient, type CompileDiagnostic, type CompileOutcome, type PluginAddress, type UpstreamVersionByOrigin,
} from '../client';
import type { OriginFiles, OriginFilesOf } from '../instanceLoader/loadOrderSnapshot';
import type { InstanceValue } from '../instanceLoader/instance';
import {
  trackedFoldersOf, registerTrackedRepositories, pluginRepositoriesOf, pluginAddressKey,
} from './trackedRepositories';
import { trackProgressMessage } from './trackProgress';
import { PluginNode, type PluginsTreeNode } from './PluginsTreeProvider';
import {
  compilableSelected, pluginsGestureEntry, selectionArgument, type GestureEntry,
} from './gestureEntry';
import type { SelectionOutcome } from '../ports/selectionOutcome';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import { errorMessage } from '../ports/errorMessage';

/** The Plugins tree's one progress surface (ADR-0002): a spinner over the view while the work
 *  runs, and the view's own message line. The composition root holds the `TreeView`, so it
 *  supplies both. */
export interface PluginsViewProgress {
  /** Runs `work` under the spinner, clearing the message on every exit path. */
  while: (work: () => Promise<void>) => Promise<void>;
  /** `undefined` gives the line back to whatever else had something to say. */
  say: (message: string | undefined) => void;
}

// ADR-0012: the origin tells two plugins that share a filename apart.
function rowName(row: PluginAddress): string {
  return `${row.name} (${row.origin})`;
}

type PresetOption = vscode.QuickPickItem & { label: 'Edits' | 'Everything' };

// plugins.md, Track, story 2: what each preset's repository tracks.
const EDITS_OPTION: PresetOption = { label: 'Edits', description: 'Keeps plugin-source/ and .gitignore' };
const EVERYTHING_OPTION: PresetOption = { label: 'Everything', description: 'Keeps every file except the plugin binaries' };
const PRESET_OPTIONS: readonly [PresetOption, PresetOption] = [EDITS_OPTION, EVERYTHING_OPTION];

// createQuickPick, not showQuickPick: only the former lets Edits show pre-selected
// (plugins.md, Pickers, Track), the same pattern DownloadsPanel.ts's pickSort uses.
function pickTrackPreset(placeholder: string): Promise<PresetOption | undefined> {
  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick<PresetOption>();
    quickPick.items = PRESET_OPTIONS;
    quickPick.placeholder = placeholder;
    quickPick.activeItems = [EDITS_OPTION];
    let accepted = false;
    quickPick.onDidAccept(() => {
      accepted = true;
      const [picked] = quickPick.selectedItems;
      quickPick.hide();
      resolve(picked);
    });
    quickPick.onDidHide(() => {
      if (!accepted) resolve(undefined);
      quickPick.dispose();
    });
    quickPick.show();
  });
}

export interface TrackDeps {
  progress: PluginsViewProgress;
  client: Pick<MEditClient, 'track'>;
  reporter: Reporter;
  onTracked: () => Promise<void>;
  plugins: () => readonly PluginAddress[];
  mods: () => InstanceValue['mods'];
  modOfRow: (value: unknown) => string | undefined;
}

/** commands.md, `track`: the mods of Mods rows, plugin rows, a column header, or the palette's
 *  selection, each sent to mEdit as its plugins, in one call and one pick. */
export function registerTrackCommand(deps: TrackDeps, paletteSelection: () => readonly unknown[]): vscode.Disposable {
  return vscode.commands.registerCommand(
    'modbench.mod.track',
    async (clicked?: unknown, selected?: readonly unknown[]) => {
      const rows = clicked === undefined ? paletteSelection() : selected ?? [clicked];
      const mods = rows.map((row) => deps.modOfRow(row) ?? pluginOriginOf(row)).filter((mod) => mod !== undefined);
      await trackMods(deps, [...new Set(mods)]);
    },
  );
}

// A plugin row or a column header acts on its plugin's mod.
function pluginOriginOf(row: unknown): string | undefined {
  return row instanceof PluginNode ? row.origin : columnHeaderOf(row)?.origin;
}

const PROVIDES_NO_PLUGIN = 'it provides no plugin';

// Edits is the default `.gitignore` preset — Everything is the opt-in authoring choice. A
// mega-plugin's serialization is a one-time, worst-case tens-of-seconds cost (ADR-0007), so this
// runs under the Plugins-view progress indicator.
async function trackMods(deps: TrackDeps, mods: readonly string[]): Promise<void> {
  const { progress, client, reporter, onTracked } = deps;
  const instancePlugins = deps.plugins();
  const pluginsOf = (mod: string): PluginAddress[] =>
    instancePlugins.filter((p) => p.origin === mod).map(({ name, origin }) => ({ name, origin }));
  const withPlugins = mods.filter((mod) => pluginsOf(mod).length > 0);
  const pluginless = mods.filter((mod) => !withPlugins.includes(mod));
  const [firstMod] = withPlugins;
  if (firstMod === undefined) {
    reportRefused(reporter, mods, pluginless);
    return;
  }
  const addressed = withPlugins.flatMap(pluginsOf);
  const upstreamVersionByOrigin = upstreamVersionByOriginOf(deps.mods(), withPlugins);
  const what = withPlugins.length === 1 ? `"${firstMod}"` : `${withPlugins.length} mods`;

  const choice = await pickTrackPreset(`Track ${what}`);
  if (!choice) return;

  await progress.while(async () => {
    progress.say(trackProgressMessage(firstMod, { phase: 'Idle', pluginsDone: 0, pluginsTotal: 0 }));
    const result = await client.track(addressed, choice.label, upstreamVersionByOrigin, {
      onProgress: (status) => { progress.say(trackProgressMessage(status.origin ?? firstMod, status)); },
    });
    if (isRefused(result)) { reporter.report('error', result.message); return; }
    // The row turns tracked when the `.git` the track made reaches the Instance adapter's watch.
    if (result.landed.length > 0) await onTracked();
    const refused = reportRefused(reporter, mods, pluginless, { total: addressed.length, outcome: result });
    if (!refused && result.landed.length > 0) reporter.landed(`Tracked ${what}.`);
  });
}

function upstreamVersionByOriginOf(entries: InstanceValue['mods'], mods: readonly string[]): UpstreamVersionByOrigin {
  return Object.fromEntries(entries.flatMap((entry) =>
    (entry.kind === 'mod' && entry.version !== undefined && mods.includes(entry.name) ? [[entry.name, entry.version]] : [])));
}

// commands.md, "each item lands on its own": one notification naming each mod that provides no
// plugin and each plugin mEdit refused. Returns whether it named any.
function reportRefused(
  reporter: Reporter, mods: readonly string[], pluginless: readonly string[],
  plugins?: { total: number; outcome: SelectionOutcome<PluginAddress> },
): boolean {
  const refusedPlugins = plugins?.outcome.refused ?? [];
  const counts = [
    ...(pluginless.length > 0 ? [`${pluginless.length} of ${mods.length} mods`] : []),
    ...(plugins && refusedPlugins.length > 0 ? [`${refusedPlugins.length} of ${plugins.total} plugins`] : []),
  ];
  if (counts.length === 0) return false;
  reporter.selectionOutcome(`Could not track ${counts.join(' and ')}.`, {
    landed: (plugins?.outcome.landed ?? []).map(rowName),
    refused: [
      ...pluginless.map((mod) => ({ item: mod, reason: PROVIDES_NO_PLUGIN })),
      ...refusedPlugins.map(({ item, reason }) => ({ item: rowName(item), reason })),
    ],
  }, (name) => name);
  return true;
}

/** What decompile needs: the call, the view's progress bar, its one confirmation, and how the user
 *  is told. */
export interface DecompileDeps {
  client: Pick<MEditClient, 'decompile'>;
  progress: PluginsViewProgress;
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
        : selectionArgument(pluginsGestureEntry(clicked, selected, viewSelection), 'plugin')
          .map((node) => ({ name: node.plugin.name, origin: node.origin }));
      if (plugins.length === 0 || !(await confirmDecompile(deps.ask, plugins))) return;
      await deps.progress.while(async () => {
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

/** What compile needs: the tracked plugins for the palette's pick, the compile itself, the view's
 *  progress bar, where the diagnostics go, and how the user is told. */
export interface CompileDeps {
  client: Pick<MEditClient, 'getPlugins' | 'compile'>;
  progress: PluginsViewProgress;
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
  const entry = pluginsGestureEntry(clicked, selected, viewSelection);
  if (entry.clicked === undefined) return pickCompilable(deps, entry);
  return selectionArgument(entry, 'plugin').map((node) => ({ name: node.plugin.name, origin: node.origin }));
}

// plugins.md, Compile, story 3: from the palette, a pick of the tracked, editable plugins. An
// extension cannot tell whether the Plugins view has focus, so it always asks, a selected
// compilable plugin first.
async function pickCompilable(deps: CompileDeps, entry: GestureEntry): Promise<PluginAddress[] | undefined> {
  const selected = compilableSelected(entry.selection);
  const selectedKey = selected && pluginAddressKey(selected.plugin.name, selected.origin);
  const isSelected = (p: PluginAddress) => pluginAddressKey(p.name, p.origin) === selectedKey;
  const plugins = await deps.client.getPlugins().catch((err: unknown) => {
    deps.reporter.report('error', 'Could not list the plugins to compile.', errorMessage(err));
    return undefined;
  });
  if (plugins === undefined) return undefined;
  const compilable = plugins
    .filter((p) => p.isTracked)
    .map((p) => ({ name: p.name, origin: p.origin }))
    .sort((a, b) => Number(isSelected(b)) - Number(isSelected(a)));
  const choice = await vscode.window.showQuickPick(
    compilable.map((p) => ({ label: p.name, description: p.origin })),
    { placeHolder: 'Compile which plugin?' },
  );
  return choice && [{ name: choice.label, origin: choice.description }];
}

// The compile itself, under the view's progress bar, reported once when it lands. Nothing re-reads
// `GET /plugins` after it: a compiled binary changes only bytes on disk, which the index's own
// mirror watch re-reads.
async function compilePlugins(deps: CompileDeps, plugins: readonly PluginAddress[]): Promise<void> {
  if (plugins.length === 0) return;
  await deps.progress.while(async () => {
    const outcome = await deps.client.compile(plugins);
    if (isRefused(outcome)) { deps.reporter.report('error', outcome.message); return; }
    publishLanded(deps, outcome);
    reportCompiled(deps.reporter, outcome, plugins.length);
  });
}

function publishLanded(deps: CompileDeps, outcome: CompileOutcome): void {
  for (const { plugin, diagnostics } of outcome.landed) deps.problems.publish(plugin, deps.originFiles(plugin.origin), diagnostics);
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
      { landed: outcome.landed.map((compiled) => compiled.plugin), refused: outcome.refused }, rowName);
    return;
  }
  const [only, ...more] = outcome.landed;
  if (only === undefined) return;
  const what = more.length === 0 ? `"${only.plugin.name}"` : `${outcome.landed.length} plugins`;
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

/** The one shape this extension needs from a `vscode.git` `Repository`: `status()`. */
export interface MinimalRepository {
  status(): Thenable<unknown>;
}
// Deliberately not the full upstream `git.d.ts`, just the members called, so nothing here can
// drift against an API this extension otherwise never touches. `openRepository` resolves `null`
// for "declined to open".
interface MinimalGitApi {
  openRepository(uri: vscode.Uri): Thenable<MinimalRepository | null>;
}
interface GitExtensionExports {
  getAPI(version: 1): MinimalGitApi;
}

/** Where the tracked repositories come from, where they are held, and where a failure is told. */
export interface TrackedRepositories {
  readonly client: Pick<MEditClient, 'getPlugins'>;
  readonly outputChannel: Pick<vscode.LogOutputChannel, 'warn' | 'error'>;
  readonly setPluginRepositories: (repos: Map<string, MinimalRepository>) => void;
  /** The Instance value's own two facts this needs, read fresh at call time (ADR-0007). */
  readonly trackedMods: () => ReadonlySet<string>;
  readonly modDirs: () => ReadonlyMap<string, string>;
}

// ADR-0007: one `openRepository` per distinct tracked folder, so each shows its own native Source
// Control group. A logged no-op when `vscode.git` is unavailable: this only narrows the native UI,
// never blocks reading or editing.
async function registerHeldTrackedRepositories({
  client, outputChannel, setPluginRepositories, trackedMods, modDirs,
}: TrackedRepositories): Promise<void> {
  try {
    const gitExtension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
    if (!gitExtension) {
      outputChannel.warn('[extension] vscode.git extension not found — tracked mods will not appear in Source Control');
      return;
    }
    const exports = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
    const gitApi = exports.getAPI(1);

    const plugins = await client.getPlugins();
    const folders = trackedFoldersOf(plugins, trackedMods(), modDirs());
    const folderRepositories = await registerTrackedRepositories(
      (folder) => Promise.resolve(gitApi.openRepository(vscode.Uri.file(folder))), [...folders.values()]);
    setPluginRepositories(pluginRepositoriesOf(folders, folderRepositories));
  } catch (err) {
    outputChannel.error(`[extension] registering tracked repositories with vscode.git failed: ${errorMessage(err)}`);
  }
}

/** A computed reconcile's notice, which a landed track gives too: tells the open record panels,
 *  then registers each tracked mod's repository with `vscode.git`, once per notice. */
export function conflictsComputedOver(announce: () => void, repositories: TrackedRepositories): () => Promise<void> {
  return async () => {
    announce();
    await registerHeldTrackedRepositories(repositories);
  };
}

/** `Repository.status()`, the same effect the SCM panel's Refresh button has, fired from the
 *  edit rather than waiting on the native watcher. A plugin with no handle is a silent no-op; a
 *  rejected `status()` is logged, never surfaced. */
export function refreshSourceControlFor(
  pluginRepositories: Map<string, MinimalRepository> | undefined, plugin: string, origin: string,
  outputChannel: vscode.LogOutputChannel,
): void {
  const repo = pluginRepositories?.get(pluginAddressKey(plugin, origin));
  if (!repo) return;
  void repo.status().then(undefined, (err: unknown) => {
    outputChannel.error(`[extension] refreshing Source Control status for ${plugin} failed: ${errorMessage(err)}`);
  });
}

// A record tab's column header names its plugin and origin (editor.md, Menus and keys).
function columnHeaderOf(value: unknown): { name: string; origin: string } | undefined {
  if (typeof value !== 'object' || value === null || Reflect.get(value, 'webviewSection') !== 'recordHeader') return undefined;
  const name: unknown = Reflect.get(value, 'plugin');
  const origin: unknown = Reflect.get(value, 'origin');
  return typeof name === 'string' && typeof origin === 'string' ? { name, origin } : undefined;
}
