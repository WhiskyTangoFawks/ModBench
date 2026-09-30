import * as vscode from 'vscode';
import { isRefused, type MEditClient, type CompileDiagnostic, type CompileOutcome, type PluginAddress } from '../client';
import { headerFormKeyFor } from './PluginTreeProvider';
import type { OriginFiles, OriginFilesOf } from '../instanceLoader/loadOrderSnapshot';
import {
  trackedFoldersOf, registerTrackedRepositories, pluginRepositoriesOf, pluginAddressKey, type TrackedFolderOf,
} from './trackedRepositories';
import { trackProgressMessage } from './trackProgress';
import { pluginFileOf, type PluginListNode, type PluginsTreeNode } from './PluginsTreeProvider';
import {
  compilableSelected, pluginsGestureEntry, pluralArgument, registerPluginsGesture, selectionArgument, type GestureEntry,
} from './gestureEntry';
import type { SelectionOutcome } from '../ports/selectionOutcome';
import type { Reporter } from '../ports/reporter';
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
const EDITS_OPTION: PresetOption = { label: 'Edits', description: 'Keeps source/ and .gitignore' };
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

// Edits is the default `.gitignore` preset — Everything is the opt-in authoring choice. A
// mega-plugin's serialization is a one-time, worst-case tens-of-seconds cost (ADR-0007), so this
// runs under the Plugins-view progress indicator.
export function registerTrackCommand(
  progress: PluginsViewProgress, client: Pick<MEditClient, 'track'>,
  reporter: Reporter, onTracked: () => Promise<void>,
  viewSelection: () => readonly PluginsTreeNode[],
): vscode.Disposable {
  // commands.md, "A selection is one gesture": the right-clicked row, or the whole selection when
  // that row is one of several selected, in one call and one pick.
  return registerPluginsGesture('modbench.plugin.track', viewSelection, async (entry) => {
    const nodes = pluralArgument(entry, 'plugin');
    const addressed: PluginAddress[] = nodes.map((node) => ({ name: node.plugin.name, origin: node.origin }));
    const [first] = addressed;
    if (!first) return;
    const report = (outcome: SelectionOutcome<PluginAddress>) => {
      reporter.selectionOutcome(`Could not track ${outcome.refused.length} of ${nodes.length} plugins.`, outcome, rowName);
    };

    const choice = await pickTrackPreset(nodes.length === 1 ? `Track "${first.name}"` : `Track ${nodes.length} plugins`);
    if (!choice) return;

    await progress.while(async () => {
      progress.say(trackProgressMessage(first.origin, { phase: 'Idle', pluginsDone: 0, pluginsTotal: 0 }));
      const result = await client.track(addressed, choice.label, {
        onProgress: (status) => { progress.say(trackProgressMessage(status.origin ?? first.origin, status)); },
      });
      if (isRefused(result)) { reporter.report('error', result.message); return; }
      // The row turns tracked when the `.git` the track made reaches the Instance adapter's watch.
      if (result.landed.length > 0) await onTracked();
      const [only, ...more] = result.landed;
      if (result.refused.length > 0) report(result);
      else if (only) reporter.landed(more.length === 0 ? `Tracked "${only.name}".` : `Tracked ${result.landed.length} plugins.`);
    });
  });
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
    .filter((p) => p.isTracked && !p.isImmutable)
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

// A join, not an Editing-only gesture (its argument is Mod Management's own row type), so it
// lives alongside the other plugin-row commands rather than with the record panel's own.
export function registerOpenHeaderCommand(): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.openHeader', (node?: PluginListNode) => {
    const pluginName = node && pluginFileOf(node);
    if (!pluginName) return;
    void vscode.commands.executeCommand('modbench.record.open', {
      formKey: headerFormKeyFor(pluginName), label: pluginName,
    });
  });
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

/** ADR-0007: one `openRepository` per distinct tracked folder, so each shows its own native
 *  Source Control group. A silent, logged no-op when `vscode.git` is unavailable: this only
 *  narrows the native UI, never blocks reading or editing. */
async function registerHeldTrackedRepositories(
  client: Pick<MEditClient, 'getPlugins'>, outputChannel: Pick<vscode.LogOutputChannel, 'warn' | 'error'>,
  setPluginRepositories: (repos: Map<string, MinimalRepository>) => void,
  trackedFolderOf: TrackedFolderOf,
): Promise<void> {
  try {
    const gitExtension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
    if (!gitExtension) {
      outputChannel.warn('[extension] vscode.git extension not found — tracked mods will not appear in Source Control');
      return;
    }
    const exports = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
    const gitApi = exports.getAPI(1);

    const plugins = await client.getPlugins();
    const folders = await trackedFoldersOf(plugins, trackedFolderOf);
    const folderRepositories = await registerTrackedRepositories(
      (folder) => Promise.resolve(gitApi.openRepository(vscode.Uri.file(folder))), [...folders.values()]);
    setPluginRepositories(pluginRepositoriesOf(folders, folderRepositories));
  } catch (err) {
    outputChannel.error(`[extension] registering tracked repositories with vscode.git failed: ${errorMessage(err)}`);
  }
}

/** A computed reconcile's notice, which a landed track gives too: tells the open record panels,
 *  then registers each tracked mod's repository with `vscode.git`, once per notice. */
export function conflictsComputedOver(
  announce: () => void, ...registration: Parameters<typeof registerHeldTrackedRepositories>
): () => Promise<void> {
  return async () => {
    announce();
    await registerHeldTrackedRepositories(...registration);
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
