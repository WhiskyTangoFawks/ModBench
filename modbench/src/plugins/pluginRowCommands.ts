import * as vscode from 'vscode';
import {
  isRefused, type MEditClient, type CompileDiagnostic, type CompileOutcome, type CompileSource, type PluginAddress,
} from '../client';
import { headerFormKeyFor, type PluginTreeProvider } from './PluginTreeProvider';
import { resolveOrigin } from './resolveOrigin';
import type { OriginFiles, OriginFilesOf } from '../instanceLoader/loadOrderSnapshot';
import {
  trackedModFoldersOf, registerTrackedRepositories, pluginRepositoriesOf, pluginAddressKey, type IsTracked, type PluginFolder,
} from './trackedRepositories';
import { trackProgressMessage } from './trackProgress';
import { pluginFileOf, type PluginListNode, type PluginsTreeNode } from './PluginsTreeProvider';
import {
  compilableSelected, pluginsGestureEntry, pluralArgument, registerPluginsGesture, selectionArgument, type GestureEntry,
} from './gestureEntry';
import type { ItemRefusal, SelectionOutcome } from '../ports/selectionOutcome';
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

// ADR-0012: the origin, once resolved, tells two plugins that share a filename apart; a row whose
// mod cannot be resolved has none, and none is invented for it.
type TrackedRow = { name: string; origin?: string };

function rowName(row: TrackedRow): string {
  return row.origin ? `${row.name} (${row.origin})` : row.name;
}

// Edits is the default `.gitignore` preset — Everything is the opt-in authoring choice. A
// mega-plugin's serialization is a one-time, worst-case tens-of-seconds cost (ADR-0007), so this
// runs under the Plugins-view progress indicator.
export function registerTrackCommand(
  progress: PluginsViewProgress, client: Pick<MEditClient, 'getPlugins' | 'track'>, outputChannel: vscode.LogOutputChannel,
  reporter: Reporter, treeProvider: PluginTreeProvider, onTracked: () => Promise<void>,
  viewSelection: () => readonly PluginsTreeNode[],
): vscode.Disposable {
  // commands.md, "A selection is one gesture": the right-clicked row, or the whole selection when
  // that row is one of several selected, in one call and one pick.
  return registerPluginsGesture('modbench.plugin.track', viewSelection, async (entry) => {
    const nodes = pluralArgument(entry, 'plugin');
    if (nodes.length === 0) return;

    const addressed: PluginAddress[] = [];
    const unaddressed: ItemRefusal<TrackedRow>[] = [];
    for (const node of nodes) {
      const name = node.plugin.name;
      const origin = node.origin ?? await resolveOrigin(client, name, (msg) => outputChannel.info(msg));
      if (origin) addressed.push({ name, origin });
      else unaddressed.push({ item: { name }, reason: 'its mod could not be resolved' });
    }
    const report = (outcome: SelectionOutcome<TrackedRow>) => {
      reporter.selectionOutcome(`Could not track ${outcome.refused.length} of ${nodes.length} plugins.`, outcome, rowName);
    };
    const [first] = addressed;
    if (!first) { report({ landed: [], refused: unaddressed }); return; }

    const choice = await vscode.window.showQuickPick<vscode.QuickPickItem & { label: 'Edits' | 'Everything' }>(
      [
        { label: 'Edits', description: 'Source only — recommended for downloaded mods' },
        { label: 'Everything', description: 'Source + assets — for authoring a mod from scratch' },
      ],
      {
        placeHolder: nodes.length === 1
          ? `Track "${first.name}" — what should its .gitignore include?`
          : `Track ${nodes.length} plugins — what should their .gitignore include?`,
      },
    );
    if (!choice) return;

    await progress.while(async () => {
      progress.say(trackProgressMessage(first.origin, { phase: 'Idle', pluginsDone: 0, pluginsTotal: 0 }));
      const result = await client.track(addressed, choice.label, {
        onProgress: (status) => { progress.say(trackProgressMessage(status.origin ?? first.origin, status)); },
      });
      if (isRefused(result)) { reporter.report('error', result.message); return; }
      const outcome = { landed: result.landed, refused: [...unaddressed, ...result.refused] };
      if (outcome.landed.length > 0) {
        // Tracked-ness isn't plugin metadata the tree renders, but the row needs to gain its Track
        // menu entry's opposite. Not the filter-match set: tracking changes no record.
        treeProvider.refresh();
        await onTracked();
      }
      const [only, ...more] = outcome.landed;
      if (outcome.refused.length > 0) report(outcome);
      else if (only) reporter.landed(more.length === 0 ? `Tracked "${only.name}".` : `Tracked ${outcome.landed.length} plugins.`);
    });
  });
}

/** What compile needs: the plugins' origins and the compile itself, the view's progress bar, where
 *  the diagnostics go, and how the user is told and asked. */
export interface CompileDeps {
  client: Pick<MEditClient, 'getPlugins' | 'compile'>;
  progress: PluginsViewProgress;
  reporter: Reporter;
  ask: AskQuestion;
  diagnostics: vscode.DiagnosticCollection;
  originFiles: OriginFilesOf;
  log: (message: string) => void;
}

/** compile's Option, as a caller that supplies it passes it after the Argument. */
export interface CompileOptions {
  source: CompileSource;
}

function sourceOf(option: unknown): CompileSource {
  return typeof option === 'object' && option !== null && Reflect.get(option, 'source') === 'main' ? 'main' : 'workingTree';
}

/** commands.md, `compile`: the plugins, the selection included, from a Plugins row, a record tab's
 *  column header, or the palette's pick; the source is the working tree unless the caller names
 *  `main`. */
export function registerCompileCommand(
  deps: CompileDeps, viewSelection: () => readonly PluginsTreeNode[],
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'modbench.plugin.compile',
    async (clicked?: unknown, selected?: readonly PluginsTreeNode[], option?: unknown) => {
      const source = sourceOf(option);
      const argument = await argumentOf(deps, clicked, selected, viewSelection);
      if (argument === undefined) return;
      if (source === 'main' && argument.addressed.length > 0 && !await confirmedFromMain(deps.ask, argument.addressed)) return;
      await compilePlugins(deps, argument, source);
    },
  );
}

/** compile's Argument: the plugins it sends, and those refused before it could, each named. */
interface CompileArgument {
  addressed: PluginAddress[];
  unaddressed: ItemRefusal<TrackedRow>[];
}

async function argumentOf(
  deps: CompileDeps, clicked: unknown, selected: readonly PluginsTreeNode[] | undefined,
  viewSelection: () => readonly PluginsTreeNode[],
): Promise<CompileArgument | undefined> {
  const header = columnHeaderOf(clicked);
  if (header) return { addressed: [header], unaddressed: [] };
  const entry = pluginsGestureEntry(clicked, selected, viewSelection);
  return entry.clicked === undefined ? pickCompilable(deps, entry) : addressed(deps, entry);
}

// ADR-0012: a row's origin, when it has none, is resolved; a plugin whose mod cannot be resolved is
// refused by name, and none is invented for it.
async function addressed(deps: CompileDeps, entry: GestureEntry): Promise<CompileArgument> {
  const argument: CompileArgument = { addressed: [], unaddressed: [] };
  for (const node of selectionArgument(entry, 'plugin')) {
    const name = node.plugin.name;
    const origin = node.origin ?? await resolveOrigin(deps.client, name, deps.log);
    if (origin) argument.addressed.push({ name, origin });
    else argument.unaddressed.push({ item: { name }, reason: 'its mod could not be resolved' });
  }
  return argument;
}

// plugins.md, Compile, story 5: from the palette, a pick of the tracked, editable plugins. An
// extension cannot tell whether the Plugins view has focus, so it always asks, a selected
// compilable plugin first.
async function pickCompilable(deps: CompileDeps, entry: GestureEntry): Promise<CompileArgument | undefined> {
  const selected = compilableSelected(entry.selection);
  const isSelected = (p: PluginAddress) => selected !== undefined && p.name === selected.plugin.name && p.origin === selected.origin;
  const compilable = (await deps.client.getPlugins())
    .filter((p) => p.isTracked && !p.isImmutable)
    .flatMap((p) => (p.origin ? [{ name: p.name, origin: p.origin }] : []))
    .sort((a, b) => Number(isSelected(b)) - Number(isSelected(a)));
  const choice = await vscode.window.showQuickPick(
    compilable.map((p) => ({ label: p.name, description: p.origin })),
    { placeHolder: 'Compile which plugin?' },
  );
  return choice && { addressed: [{ name: choice.label, origin: choice.description }], unaddressed: [] };
}

// plugins.md, Compile, story 2: compile from main confirms, and Esc compiles nothing.
async function confirmedFromMain(ask: AskQuestion, plugins: readonly PluginAddress[]): Promise<boolean> {
  const [only, ...more] = plugins;
  const named = only !== undefined && more.length === 0 ? `"${only.name}"` : `${plugins.length} plugins`;
  const accept = 'Compile from main';
  const choice = await ask(`Compile ${named} from main?`, {
    modal: true,
    detail: `${more.length === 0 ? 'Its binary is' : 'Their binaries are'} written from what main holds. ` +
      'Your edit branch and your working tree stay as they are.',
  }, accept);
  return choice === accept;
}

/** The compile itself, under the view's progress bar, reported once when it lands. Nothing re-reads
 *  `GET /plugins` after it: a compiled binary changes only bytes on disk, which the index's own
 *  mirror watch re-reads. */
async function compilePlugins(deps: CompileDeps, argument: CompileArgument, source: CompileSource): Promise<void> {
  const { addressed: plugins, unaddressed } = argument;
  const total = plugins.length + unaddressed.length;
  if (plugins.length === 0) {
    if (total > 0) reportCompiled(deps.reporter, { landed: [], refused: [] }, unaddressed, total, source);
    return;
  }
  await deps.progress.while(async () => {
    const outcome = await deps.client.compile(plugins, source);
    if (isRefused(outcome)) { deps.reporter.report('error', outcome.message); return; }
    publishLanded(deps, outcome);
    reportCompiled(deps.reporter, outcome, unaddressed, total, source);
  });
}

// One mod's diagnostics replace what that mod's folder held, so every plugin of the mod that
// compiled is published together.
function publishLanded(deps: CompileDeps, outcome: CompileOutcome): void {
  const byOrigin = new Map<string, CompileDiagnostic[]>();
  for (const compiled of outcome.landed) {
    byOrigin.set(compiled.plugin.origin, [...(byOrigin.get(compiled.plugin.origin) ?? []), ...compiled.diagnostics]);
  }
  for (const [origin, diagnostics] of byOrigin) publishCompileDiagnostics(deps.diagnostics, deps.originFiles(origin), diagnostics);
}

function diagnosticsWords(count: number): string {
  return `${count} ${count === 1 ? 'diagnostic' : 'diagnostics'}. See the Problems panel.`;
}

// plugins.md, Compile, story 3, and Reporting: one notification when it lands, naming each refused
// plugin and why, and pointing at the Problems panel when it left diagnostics.
function reportCompiled(
  reporter: Reporter, outcome: CompileOutcome, unaddressed: readonly ItemRefusal<TrackedRow>[], total: number,
  source: CompileSource,
): void {
  const diagnostics = outcome.landed.reduce((sum, compiled) => sum + compiled.diagnostics.length, 0);
  const refused: ItemRefusal<TrackedRow>[] = [...unaddressed, ...outcome.refused];
  if (refused.length > 0) {
    const rest = diagnostics > 0 ? ` The rest compiled with ${diagnosticsWords(diagnostics)}` : '';
    reporter.selectionOutcome(
      `Could not compile ${refused.length} of ${total} plugins.${rest}`,
      { landed: outcome.landed.map((compiled) => compiled.plugin), refused }, rowName);
    return;
  }
  const [only, ...more] = outcome.landed;
  if (only === undefined) return;
  const what = more.length === 0 ? `"${only.plugin.name}"` : `${outcome.landed.length} plugins`;
  const from = source === 'main' ? ' from main' : '';
  reporter.landed(diagnostics > 0 ? `Compiled ${what}${from} with ${diagnosticsWords(diagnostics)}` : `Compiled ${what}${from}.`);
}

// A join, not an Editing-only gesture (its argument is Mod Management's own row type), so it
// lives alongside the other plugin-row commands rather than with the record panel's own.
export function registerOpenHeaderCommand(): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.openHeader', (node?: PluginListNode) => {
    const pluginName = node && pluginFileOf(node);
    if (!pluginName) return;
    void vscode.commands.executeCommand('modbench.openEditor', {
      formKey: headerFormKeyFor(pluginName), label: pluginName,
    });
  });
}

/** Replaces whatever this mod's source files held from the last compile — never additive, or
 *  a fixed diagnostic would survive forever. `files` is the Instance value's answer for the
 *  origin: `overwrite` and `Data` are not under `mods/` (ADR-0012). */
export function publishCompileDiagnostics(
  collection: vscode.DiagnosticCollection, files: OriginFiles | undefined, diagnostics: readonly CompileDiagnostic[],
): void {
  if (files === undefined) return;

  // Clear every URI this collection holds under this folder before republishing —
  // DiagnosticCollection has no "clear just this prefix" primitive, so this walks every entry it holds.
  for (const [uri] of collection) {
    if (files.holds(uri.fsPath)) collection.delete(uri);
  }

  const byUri = new Map<string, vscode.Diagnostic[]>();
  for (const d of diagnostics) {
    const fsPath = files.file(d.sourceRelativePath);
    const list = byUri.get(fsPath) ?? [];
    list.push(new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), d.message, vscode.DiagnosticSeverity.Warning));
    byUri.set(fsPath, list);
  }
  for (const [fsPath, list] of byUri) collection.set(vscode.Uri.file(fsPath), list);
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
export async function registerHeldTrackedRepositories(
  client: Pick<MEditClient, 'getPlugins'>, outputChannel: vscode.LogOutputChannel,
  setPluginRepositories: (repos: Map<string, MinimalRepository>) => void,
  isTracked: IsTracked, pluginFolder: PluginFolder,
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
    const folders = await trackedModFoldersOf(plugins, isTracked, pluginFolder);
    const folderRepositories = await registerTrackedRepositories(
      (folder) => Promise.resolve(gitApi.openRepository(vscode.Uri.file(folder))), folders);
    setPluginRepositories(pluginRepositoriesOf(plugins, folderRepositories, pluginFolder));
  } catch (err) {
    outputChannel.error(`[extension] registering tracked repositories with vscode.git failed: ${errorMessage(err)}`);
  }
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
