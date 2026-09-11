import * as vscode from 'vscode';
import * as path from 'path';
import { isRefused, type MEditClient, type CompileResult } from '../medit/client';
import { headerFormKeyFor, type PluginTreeProvider } from './PluginTreeProvider';
import { resolveCompileTarget } from '../medit/compileTarget';
import { promptEslFlagRemoval } from '../medit/promptEslFlagRemoval';
import { resolveOrigin } from '../medit/resolveOrigin';
import type { OriginFolder } from '../modmanager/loadOrderSnapshot';
import { trackedModFoldersOf, registerTrackedRepositories, pluginRepositoriesOf } from '../medit/trackedRepositories';
import { runRebase } from './externalChangeGestures';
import { makeMergeEditorOpener } from './externalChangeWiring';
import { trackProgressMessage } from '../medit/trackProgress';
import { pluginFileOf, type PluginListNode } from './PluginsTreeProvider';
import type { Reporter } from '../reporter';
import type { AskQuestion } from '../dialog';
import { withPluginsViewProgress, type ExtensionSession } from '../session';
import { say } from '../editingTeardown';

// Everything Save & Compile and Compile at Ref call: resolving an origin and a record's owner,
// compiling, and (on an ESL contradiction) editing the header to retry.
type CompileClient = Pick<MEditClient, 'getPlugins' | 'getRecordOwner' | 'compile' | 'editRecord'>;

// Edits is the default `.gitignore` preset — Everything is the opt-in authoring choice. A
// mega-plugin's serialization is a one-time, worst-case tens-of-seconds cost (ADR-0007), so this
// runs under the Plugins-view progress indicator.
export function registerTrackCommand(
  session: ExtensionSession, client: Pick<MEditClient, 'getPlugins' | 'track'>, outputChannel: vscode.LogOutputChannel,
  reporter: Reporter, treeProvider: PluginTreeProvider, onTracked: () => Promise<void>,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.pluginListTree.track', async (node: PluginListNode | undefined) => {
    if (node?.kind !== 'plugin') return;
    const name = node.plugin.name;
    const origin = await resolveOrigin(client, name, (msg) => outputChannel.info(msg));
    if (!origin) {
      // ADR-0019: an explicit user action failed — notify + log, never a silent no-op.
      reporter.report('error', `Could not resolve which mod "${name}" belongs to.`);
      return;
    }

    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Edits', description: 'Source only — recommended for downloaded mods' },
        { label: 'Everything', description: 'Source + assets — for authoring a mod from scratch' },
      ],
      { placeHolder: `Track "${name}" — what should its .gitignore include?` },
    );
    if (!choice) return;

    await withPluginsViewProgress(session, async () => {
      say(session, trackProgressMessage(origin, { phase: 'Idle', pluginsDone: 0, pluginsTotal: 0 }));
      const result = await client.track(origin, choice.label as 'Edits' | 'Everything', {
        onProgress: (status) => say(session, trackProgressMessage(origin, status)),
      });
      if (isRefused(result)) { reporter.report('error', result.message); return; }
      // Tracked-ness isn't plugin metadata the tree renders, but the row needs to gain its Track
      // menu entry's opposite. Not the filter-match set: tracking changes no record.
      treeProvider.refresh();
      reporter.landed(`Tracked "${origin}".`);
      await onTracked();
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
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.pluginListTree.rebase', async (node?: PluginListNode) => {
    if (node?.kind !== 'plugin') return;
    const name = node.plugin.name;
    const origin = await resolveOrigin(client, name, (msg) => outputChannel.info(msg));
    if (!origin) {
      reporter.report('error', `Could not resolve which mod "${name}" belongs to.`);
      return;
    }

    const result = await runRebase({
      client, openMergeEditor: makeMergeEditorOpener(client, outputChannel),
      showError: (message) => reporter.report('error', message),
      refreshTree: () => treeProvider.refresh(),
      refreshMatchingPlugins,
    }, origin);
    if (!result) return; // transport failure or refusal already surfaced by runRebase

    if (result.outcome === 'Refused') {
      reporter.report('warning', result.refusalReason ?? 'Rebase refused.');
    } else if (result.outcome === 'Clean') {
      reporter.landed(`Rebased "${origin}" onto the updated baseline.`);
    } else {
      reporter.report(
        'warning',
        `Rebasing "${origin}" hit conflicts — resolve them in the opened merge editor(s), ` +
          'then run "Modbench: Rebase onto Updated Baseline" again to continue.',
      );
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
  originFolder: OriginFolder,
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

    await compileAndReport(client, diagnostics, originFolder, reporter, ask, target, undefined);
  });
}

// One confirmation names the ref literally, never "pristine" — there is no stored mode
// (ADR-0007). Tree-row only: naming a ref with no plugin in hand isn't worth a QuickPick.
export function registerCompileAtRefCommand(
  client: CompileClient,
  outputChannel: vscode.LogOutputChannel, reporter: Reporter, ask: AskQuestion,
  diagnostics: vscode.DiagnosticCollection,
  originFolder: OriginFolder,
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

    await compileAndReport(client, diagnostics, originFolder, reporter, ask, target, 'main');
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
  client: CompileClient, diagnostics: vscode.DiagnosticCollection, originFolder: OriginFolder,
  reporter: Reporter, ask: AskQuestion,
  target: { name: string; origin: string }, atRef: string | undefined,
): Promise<void> {
  const result = await client.compile(target.name, target.origin, atRef);
  if (!result) return;
  if (isRefused(result)) { reporter.report('error', result.message); return; }

  publishCompileDiagnostics(diagnostics, originFolder(target.origin), result);

  const refSuffix = atRef ? ` at "${atRef}"` : '';
  if (!result.succeeded) {
    if (result.eslContradiction
        && await promptEslFlagRemoval(target, result.refusalReason ?? '', 'Compile', client, ask)) {
      await compileAndReport(client, diagnostics, originFolder, reporter, ask, target, atRef);
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
 *  a fixed diagnostic would survive forever. `modFolder` is the Instance value's answer for the
 *  origin: `overwrite` and `Data` are not under `mods/` (ADR-0012). */
export function publishCompileDiagnostics(
  collection: vscode.DiagnosticCollection, modFolder: string | undefined, result: CompileResult,
): void {
  if (modFolder === undefined) return;

  // Clear every URI this collection holds under this folder before republishing —
  // DiagnosticCollection has no "clear just this prefix" primitive, so this walks every entry it holds.
  for (const [uri] of collection) {
    if (uri.fsPath.startsWith(modFolder + path.sep)) collection.delete(uri);
  }

  const byUri = new Map<string, vscode.Diagnostic[]>();
  for (const d of result.diagnostics) {
    const fsPath = path.join(modFolder, d.sourceRelativePath);
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
    const folders = trackedModFoldersOf(plugins);
    const folderRepositories = await registerTrackedRepositories(
      (folder) => Promise.resolve(gitApi.openRepository(vscode.Uri.file(folder))), folders);
    setPluginRepositories(pluginRepositoriesOf(plugins, folderRepositories));
  } catch (err) {
    outputChannel.error(`[extension] registering tracked repositories with vscode.git failed: ${err instanceof Error ? err.message : String(err)}`);
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
    outputChannel.error(`[extension] refreshing Source Control status for ${plugin} failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}
