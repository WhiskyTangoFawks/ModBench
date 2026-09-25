import * as vscode from 'vscode';
import { isRefused, type MEditClient, type CompileResult, type PluginAddress } from '../client';
import { headerFormKeyFor, type PluginTreeProvider } from './PluginTreeProvider';
import { resolveCompileTarget } from './compileTarget';
import { offerEslFlagRemoval } from './eslFlagRemovalPrompt';
import { resolveOrigin } from './resolveOrigin';
import type { OriginFiles, OriginFilesOf } from '../instanceLoader/loadOrderSnapshot';
import {
  trackedModFoldersOf, registerTrackedRepositories, pluginRepositoriesOf, type IsTracked, type PluginFolder,
} from './trackedRepositories';
import { runRebase } from './externalChangeGestures';
import { makeMergeEditorOpener } from './externalChangeWiring';
import { trackProgressMessage } from './trackProgress';
import { pluginFileOf, type PluginListNode, type PluginsTreeNode } from './PluginsTreeProvider';
import { pluralArgument, registerPluginsGesture } from './gestureEntry';
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

// Everything Save & Compile and Compile at Ref call: resolving an origin and a record's owner,
// compiling, and (on an ESL contradiction) editing the header to retry.
type CompileClient = Pick<MEditClient, 'getPlugins' | 'getRecordOwner' | 'compile' | 'editRecord'>;

// ADR-0012: the origin, once resolved, tells two copies of one file apart; a row whose mod cannot
// be resolved has none, and none is invented for it.
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

// Origin-scoped: the repo, not any one plugin, is the unit of baselines and rebase. Also the
// *re-runnable* form — {@link SourceRepository.RebaseEditBranch}'s resumption-aware design means
// this same command both starts a rebase and resumes one left conflicted.
export function registerRebaseCommand(
  client: Pick<MEditClient, 'getPlugins' | 'keepAsMyEdit' | 'absorbUpstreamUpdate' | 'rebaseOntoMain'>,
  outputChannel: vscode.LogOutputChannel, reporter: Reporter,
  treeProvider: PluginTreeProvider, refreshMatchingPlugins: () => void,
  originFiles: OriginFilesOf,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.mod.rebaseEditBranch', async (node?: PluginListNode) => {
    if (node?.kind !== 'plugin') return;
    const name = node.plugin.name;
    const origin = await resolveOrigin(client, name, (msg) => outputChannel.info(msg));
    if (!origin) {
      reporter.report('error', `Could not resolve which mod "${name}" belongs to.`);
      return;
    }

    const result = await runRebase({
      client, openMergeEditor: makeMergeEditorOpener(originFiles, outputChannel, reporter),
      showError: (message) => reporter.report('error', message),
      refreshTree: () => treeProvider.refresh(),
      refreshMatchingPlugins,
    }, origin);
    if (!result) return; // transport failure or refusal already surfaced by runRebase

    if (result.outcome === 'Refused') {
      reporter.report('warning', result.refusalReason ?? 'mEdit gave no reason.');
    } else if (result.outcome === 'Conflicted' && result.refusalReason) {
      reporter.report('warning', result.refusalReason);
    }
  });
}

// Reachable from a plugin row, from the record editor's title bar (the *active* record's owning
// plugin — never a QuickPick, which risks compiling the wrong plugin), and from the palette
// (QuickPick fallback only when neither is in hand).
export function registerSaveAndCompileCommand(
  client: CompileClient,
  // Editor's own `ActiveRecordTracker`, structural: this module names no Editor type, only
  // the one reader it needs — the active panel's own FormKey.
  activeRecordTracker: { current(): string | undefined },
  outputChannel: vscode.LogOutputChannel,
  reporter: Reporter, ask: AskQuestion,
  diagnostics: vscode.DiagnosticCollection,
  originFiles: OriginFilesOf,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.saveAndCompile', async (node?: PluginListNode) => {
    const target = await resolveCompileTarget(
      node?.kind === 'plugin' ? node.plugin.name : undefined,
      activeRecordTracker.current(),
      {
        resolveOrigin: (name) => resolveOrigin(client, name, (msg) => outputChannel.info(msg)),
        getRecordOwner: (formKey) => client.getRecordOwner(formKey),
        onError: (message) => reporter.report('error', message),
        pickPlugin: async () => {
          const plugins = await client.getPlugins();
          const choice = await vscode.window.showQuickPick(
            plugins.map((p) => ({ label: p.name, description: p.origin })),
            { placeHolder: 'Save & Compile which plugin?' },
          );
          if (!choice) return undefined;
          if (!choice.description) {
            reporter.report('error', `"${choice.label}" has no mod folder to compile into.`);
            return undefined;
          }
          return { name: choice.label, origin: choice.description };
        },
      },
    );
    if (!target) return;

    await compileAndReport(client, diagnostics, originFiles, reporter, ask, target, undefined);
  });
}

// One confirmation names the ref literally, never "pristine" — there is no stored mode
// (ADR-0007). Tree-row only: naming a ref with no plugin in hand isn't worth a QuickPick.
export function registerCompileAtRefCommand(
  client: CompileClient,
  outputChannel: vscode.LogOutputChannel, reporter: Reporter, ask: AskQuestion,
  diagnostics: vscode.DiagnosticCollection,
  originFiles: OriginFilesOf,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.pluginListTree.compileAtMain', async (node?: PluginListNode) => {
    if (node?.kind !== 'plugin') return;
    const target = await resolveCompileTarget(node.plugin.name, undefined, {
      resolveOrigin: (name) => resolveOrigin(client, name, (msg) => outputChannel.info(msg)),
      getRecordOwner: () => Promise.resolve(undefined),
      onError: (message) => reporter.report('error', message),
      pickPlugin: () => Promise.resolve(undefined),
    });
    if (!target) return;

    const confirmed = await ask(
      `Compile "${target.name}" at ref "main"?`,
      {
        modal: true,
        detail: `This overwrites the binary with what "main" holds, without touching your edit branch. ` +
          `Your working-tree changes stay exactly where they are.`,
      },
      'Compile at main',
    );
    if (confirmed !== 'Compile at main') return;

    await compileAndReport(client, diagnostics, originFiles, reporter, ask, target, 'main');
  });
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

/** Nothing re-reads `GET /plugins` after a compile: a compiled binary changes only bytes on
 *  disk, which the index's own mirror watch re-reads. */
export async function compileAndReport(
  client: CompileClient, diagnostics: vscode.DiagnosticCollection, originFiles: OriginFilesOf,
  reporter: Reporter, ask: AskQuestion,
  target: { name: string; origin: string }, atRef: string | undefined,
): Promise<void> {
  const result = await client.compile(target.name, target.origin, atRef);
  if (!result) return;
  if (isRefused(result)) { reporter.report('error', result.message); return; }

  publishCompileDiagnostics(diagnostics, originFiles(target.origin), result);

  const refSuffix = atRef ? ` at "${atRef}"` : '';
  if (!result.succeeded) {
    if (result.eslContradiction
        && await offerEslFlagRemoval(target, result.refusalReason ?? '', 'Compile', client, ask, reporter)) {
      await compileAndReport(client, diagnostics, originFiles, reporter, ask, target, atRef);
      return;
    }
    reporter.report('error', `Could not compile "${target.name}"${refSuffix} — ${result.refusalReason}`);
    return;
  }
  reporter.landed(
    result.diagnostics.length > 0
      ? `Compiled "${target.name}"${refSuffix} — ${result.diagnostics.length} diagnostic(s), see Problems panel.`
      : `Compiled "${target.name}"${refSuffix}.`,
  );
}

/** Replaces whatever this plugin's source files held from the last compile — never additive, or
 *  a fixed diagnostic would survive forever. `files` is the Instance value's answer for the
 *  origin: `overwrite` and `Data` are not under `mods/` (ADR-0012). */
export function publishCompileDiagnostics(
  collection: vscode.DiagnosticCollection, files: OriginFiles | undefined, result: CompileResult,
): void {
  if (files === undefined) return;

  // Clear every URI this collection holds under this folder before republishing —
  // DiagnosticCollection has no "clear just this prefix" primitive, so this walks every entry it holds.
  for (const [uri] of collection) {
    if (files.holds(uri.fsPath)) collection.delete(uri);
  }

  const byUri = new Map<string, vscode.Diagnostic[]>();
  for (const d of result.diagnostics) {
    const fsPath = files.file(d.sourceRelativePath);
    const list = byUri.get(fsPath) ?? [];
    list.push(new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), d.message, vscode.DiagnosticSeverity.Warning));
    byUri.set(fsPath, list);
  }
  for (const [fsPath, list] of byUri) collection.set(vscode.Uri.file(fsPath), list);
}

/** The one shape this extension needs from a `vscode.git` `Repository` — just `status()`,
 *  which forces the repository to re-check the working tree, the same effect the SCM panel's own
 *  manual Refresh button has. */
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
  pluginRepositories: Map<string, MinimalRepository> | undefined, plugin: string, outputChannel: vscode.LogOutputChannel,
): void {
  const repo = pluginRepositories?.get(plugin);
  if (!repo) return;
  void repo.status().then(undefined, (err: unknown) => {
    outputChannel.error(`[extension] refreshing Source Control status for ${plugin} failed: ${errorMessage(err)}`);
  });
}
