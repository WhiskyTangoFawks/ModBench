import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { Mo2ModlistSource } from './mo2/Mo2ModlistSource';
import { ModListProvider, ModNode, OverwriteNode, SeparatorNode, type ModlistNode } from './ModListProvider';
import { createOverwriteWatcher } from './overwriteWatcher';
import { createModsWatcher } from './modsWatcher';
import { OverwriteDecorationProvider } from './OverwriteDecorationProvider';
import type { GameDirectory } from './gameDirectory';
import { type GameDirectoryResolver } from './gameDirectoryResolver';
import { deploy, purge, type LoadOrderDeployment } from './deployer';
import { buildFileConflictIndex } from './fileConflictIndex';
import { detectRoot } from './install/detectRoot';
import { extractArchive } from './install/extractArchive';
import { registerDownloadsHiddenToggleCommands, registerDownloadsMultiRowCommands, registerDownloadsSingleRowCommands, registerDownloadsSortCommand } from './DownloadsPanel';
import { DownloadsProvider } from './DownloadsProvider';
import { createDownloadsWatcher } from './downloadsWatcher';
import { HiddenDownloadDecorationProvider } from './HiddenDownloadDecorationProvider';
import { makeReporter } from '../reporter';
import { registerNameFilter, type NameFilter } from '../nameFilter';
import { meditConfig, makeDetectPaths, setMo2InstanceContext } from '../workspaceConfig';


/** Stub provider for the Mods view when the workspace isn't an MO2
 *  instance. Always empty so VS Code's `viewsWelcome` contribution (gated on
 *  `modbench.workspaceMo2CheckDone` and `modbench.workspaceIsMo2Instance` together)
 *  renders instead of the tree — getTreeItem is unreachable since getChildren never yields
 *  an element to render. */
export const NOT_MO2_INSTANCE_PROVIDER: vscode.TreeDataProvider<never> = {
  getTreeItem: () => { throw new Error('unreachable — NOT_MO2_INSTANCE_PROVIDER never yields children'); },
  getChildren: () => [],
};

/** Loadout core commands: refresh, switch profile, filter. One call site (registerLoadoutView),
 *  so its params are positional, not a Deps bundle — #628: a bundle earns its keep by being
 *  shared across more than one consumer or call site (see EditorCommandDeps, ModInstallDeps,
 *  LoadoutViewDeps for real examples), not merely by having several fields.
 *  notifyLoadoutHeaderChanged/requestLoadOrderSync: ADR-0044 / the Loadout header — a profile
 *  switch is the next snapshot, and the header's own profile readout has to move with it — both
 *  narrow callbacks against the composition root's session object, since this is otherwise a
 *  pure Mod-Management registrar. */
export function registerModListCoreCommands(
  modListProvider: ModListProvider, modlistSource: Mo2ModlistSource, updateProfileDescription: () => Promise<void>,
  notifyLoadoutHeaderChanged: () => void, requestLoadOrderSync: () => void,
): vscode.Disposable[] {
  return [
      vscode.commands.registerCommand('modbench.modList.view.winningAtTop', () => {
        modListProvider.toggleViewDirection();
        void vscode.commands.executeCommand('setContext', 'modbench.modList.winningAtTop', true);
      }),
      vscode.commands.registerCommand('modbench.modList.view.losingAtTop', () => {
        modListProvider.toggleViewDirection();
        void vscode.commands.executeCommand('setContext', 'modbench.modList.winningAtTop', false);
      }),
      vscode.commands.registerCommand('modbench.modList.switchProfile', async () => {
        const [profiles, active] = await Promise.all([
          modlistSource.listProfiles(),
          modlistSource.getActiveProfile(),
        ]);
        const picked = await vscode.window.showQuickPick(
          profiles.map((p) => ({ label: p, description: p === active ? 'current' : undefined })),
          { placeHolder: 'Switch profile' },
        );
        if (!picked || picked.label === active) return;
        await modListProvider.switchProfile(picked.label);
        void updateProfileDescription();
        notifyLoadoutHeaderChanged();
        // ADR-0044: a profile switch is the next snapshot, not a teardown — the backend keeps
        // running, and the index (keyed on the instance, shared by every profile) makes
        // the reconcile cheap. The profile files themselves are not watched for this (switching
        // writes ModOrganizer.ini, not modlist/plugins.txt), so this asks explicitly.
        requestLoadOrderSync();
      }),
  ];
}
export interface ModInstallDeps {
  modlistSource: Mo2ModlistSource;
  runModAction: (label: string, failMessage: string, action: () => Promise<void>) => Promise<void>;
  promptModName: (defaultName: string) => Thenable<string | undefined>;
  warnIfFomod: (name: string, isFomod: boolean) => void;
}
/** Loadout install commands: from archive, from folder. */
export function registerModInstallCommands(deps: ModInstallDeps): vscode.Disposable[] {
  const { modlistSource, runModAction, promptModName, warnIfFomod } = deps;
  return [
      vscode.commands.registerCommand('modbench.modList.installFromArchive', async (archivePath?: string): Promise<boolean> => {
        let archive = archivePath;
        if (!archive) {
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'Mod archives': ['zip', '7z', 'rar'] },
            openLabel: 'Install',
          });
          archive = picked?.[0]?.fsPath;
        }
        if (!archive) return false;
        const resolvedArchive = archive;
        const name = await promptModName(path.basename(resolvedArchive).replace(/\.(zip|7z|rar)$/i, ''));
        if (!name) return false;
        let succeeded = false;
        await runModAction('installFromArchive', `Failed to install "${name}".`, async () => {
          const staging = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'medit-install-'));
          try {
            await extractArchive(resolvedArchive, staging);
            const { sourceDir, isFomod } = await detectRoot(staging);
            await modlistSource.installMod(name, sourceDir, { installationFile: path.basename(resolvedArchive) });
            warnIfFomod(name, isFomod);
            succeeded = true;
          } finally {
            await fs.promises.rm(staging, { recursive: true, force: true });
          }
        });
        return succeeded;
      }),
      vscode.commands.registerCommand('modbench.modList.installFromFolder', async () => {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: 'Install',
        });
        const folder = picked?.[0]?.fsPath;
        if (!folder) return;
        const name = await promptModName(path.basename(folder));
        if (!name) return;
        await runModAction('installFromFolder', `Failed to install "${name}".`, async () => {
          const { sourceDir, isFomod } = await detectRoot(folder);
          await modlistSource.installMod(name, sourceDir, {});
          warnIfFomod(name, isFomod);
        });
      }),
  ];
}
/** Loadout per-mod context commands: reveal, separator ops, uninstall, Nexus. One call site
 *  (registerLoadoutView) — positional params, not a Deps bundle; see registerModListCoreCommands's
 *  own comment on why (#628). */
export function registerModContextCommands(
  instanceRoot: string, modlistSource: Mo2ModlistSource, outputChannel: vscode.LogOutputChannel,
  runModAction: (label: string, failMessage: string, action: () => Promise<void>) => Promise<void>,
): vscode.Disposable[] {
  return [
      vscode.commands.registerCommand('modbench.modList.mod.openInExplorer', async (node: ModNode) => {
        if (node?.kind !== 'mod') return;
        const uri = vscode.Uri.file(path.join(instanceRoot, 'mods', node.mod.name));
        await vscode.commands.executeCommand('revealInExplorer', uri);
      }),
      vscode.commands.registerCommand('modbench.modList.mod.addSeparatorBelow', async (node: ModNode) => {
        if (node?.kind !== 'mod') return;
        const name = await vscode.window.showInputBox({ prompt: 'Separator name', placeHolder: 'My Group' });
        if (!name) return;
        await runModAction('addSeparatorBelow', 'Failed to add separator.', () => modlistSource.insertSeparator(name, node.mod.name));
      }),
      vscode.commands.registerCommand('modbench.modList.mod.moveToSeparator', async (node: ModNode) => {
        if (node?.kind !== 'mod') return;
        let separators: string[];
        try {
          separators = await modlistSource.listSeparators();
        } catch (err) {
          makeReporter(outputChannel, 'moveToSeparator').report('error', 'Failed to read mod list.', err instanceof Error ? err.message : String(err));
          return;
        }
        const items: Array<vscode.QuickPickItem & { sepName: string | null }> = [
          { label: 'Ungrouped', description: 'Before first separator', sepName: null },
          ...separators.map((s) => ({ label: s, sepName: s })),
        ];
        const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Move to separator…' });
        if (!picked) return;
        await runModAction('moveToSeparator', 'Failed to move mod.', () => modlistSource.moveModToSeparator(node.mod.name, picked.sepName));
      }),
      vscode.commands.registerCommand('modbench.modList.mod.uninstall', async (node: ModNode) => {
        if (node?.kind !== 'mod') return;
        const answer = await vscode.window.showWarningMessage(
          `Uninstall "${node.mod.name}"? This will permanently delete the mod folder from disk.`,
          { modal: true },
          'Uninstall',
        );
        if (answer !== 'Uninstall') return;
        await runModAction('uninstall', `Failed to uninstall "${node.mod.name}".`, () => modlistSource.removeMod(node.mod.name));
      }),
      vscode.commands.registerCommand('modbench.modList.mod.viewOnNexus', async (node: ModNode) => {
        if (node?.kind !== 'mod' || !node.mod.nexusId) return;
        const nexusId = node.mod.nexusId;
        await runModAction('viewOnNexus', 'Failed to open Nexus page.', async () => {
          const slug = await modlistSource.getNexusSlug();
          await vscode.env.openExternal(
            vscode.Uri.parse(`https://www.nexusmods.com/${slug}/mods/${nexusId}`),
          );
        });
      }),
  ];
}
/** Loadout separator context commands: rename, add-below, delete. One call site
 *  (registerLoadoutView) — positional params, not a Deps bundle; see registerModListCoreCommands's
 *  own comment on why (#628). */
export function registerSeparatorCommands(
  modlistSource: Mo2ModlistSource,
  runModAction: (label: string, failMessage: string, action: () => Promise<void>) => Promise<void>,
): vscode.Disposable[] {
  return [
      vscode.commands.registerCommand('modbench.modList.separator.rename', async (node: SeparatorNode) => {
        if (node?.kind !== 'separator') return;
        const newName = await vscode.window.showInputBox({
          prompt: 'Rename separator',
          value: node.separator.name,
        });
        if (!newName || newName === node.separator.name) return;
        await runModAction('renameSeparator', 'Failed to rename separator.', () => modlistSource.renameSeparator(node.separator.name, newName));
      }),
      vscode.commands.registerCommand('modbench.modList.separator.addSeparatorBelow', async (node: SeparatorNode) => {
        if (node?.kind !== 'separator') return;
        const name = await vscode.window.showInputBox({ prompt: 'Separator name', placeHolder: 'My Group' });
        if (!name) return;
        await runModAction('separator.addSeparatorBelow', 'Failed to add separator.', () => modlistSource.insertSeparator(name, node.separator.name));
      }),
      vscode.commands.registerCommand('modbench.modList.separator.delete', async (node: SeparatorNode) => {
        if (node?.kind !== 'separator') return;
        await runModAction('deleteSeparator', 'Failed to delete separator.', () => modlistSource.deleteSeparator(node.separator.name));
      }),
  ];
}
/** Overwrite-folder surface: a live watcher that re-renders the Mods tree
 *  as `overwrite/` fills/empties (reactive over manual refresh), plus the sole
 *  action — reveal the folder in the Explorer (single-click reuses this too). */
export function registerOverwriteView(
  instanceRoot: string,
  modListProvider: ModListProvider,
  outputChannel: vscode.LogOutputChannel,
): vscode.Disposable[] {
  return [
    createOverwriteWatcher(instanceRoot, () => modListProvider.invalidate()),
    // Tint the pinned Overwrite row reddish. Stateless: keyed on the
    // constant overwrite/ path, which matches OverwriteNode.resourceUri.
    vscode.window.registerFileDecorationProvider(new OverwriteDecorationProvider(instanceRoot)),
    vscode.commands.registerCommand('modbench.modList.overwrite.reveal', async (node: OverwriteNode) => {
      if (node?.kind !== 'overwrite') return;
      try {
        await vscode.commands.executeCommand('revealInExplorer', node.resourceUri);
      } catch (err) {
        makeReporter(outputChannel, 'overwrite.reveal').report(
          'error', 'Failed to reveal the overwrite folder in the Explorer.', err instanceof Error ? err.message : String(err));
      }
    }),
  ];
}
/** Auto-registration: a live watcher that adds a modlist.txt entry for
 *  any mods/<name>/ folder that appears while Modbench is running (dragged
 *  into Explorer, extracted by hand, or installed some other way outside
 *  Modbench) — reactive over manual, same as the overwrite/ watcher above. */
export function registerModsAutoRegisterWatcher(
  instanceRoot: string,
  modlistSource: Mo2ModlistSource,
  modListProvider: ModListProvider,
  outputChannel: vscode.LogOutputChannel,
): vscode.Disposable {
  return createModsWatcher(instanceRoot, () => {
    modlistSource
      .registerUnlistedMods()
      .then((added) => {
        if (added.length > 0) modListProvider.invalidate();
      })
      .catch((err: unknown) => {
        outputChannel.error(`[extension] auto-registering mods/ folders failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  });
}
/** The workspace is open but isn't an MO2 instance (ModOrganizer.ini,
 *  mods/, profiles/ absent). Don't build a provider that would only fail
 *  lazily on first read — register the Mods view with an always-empty stub so
 *  its native `viewsWelcome` contribution (gated on `modbench.workspaceMo2CheckDone`
 *  and `modbench.workspaceIsMo2Instance` together) renders an actionable
 *  message instead of an error tree node. */
export function registerNotMo2InstanceWelcome(
  instanceRoot: string,
  context: vscode.ExtensionContext,
  outputChannel: vscode.LogOutputChannel,
): void {
  outputChannel.info(`[extension] Workspace "${instanceRoot}" is not an MO2 instance — showing welcome content instead of the Mods tree.`);
  setMo2InstanceContext(false);
  context.subscriptions.push(
    vscode.window.createTreeView('modbench.modList', { treeDataProvider: NOT_MO2_INSTANCE_PROVIDER }),
  );
}
/** The Mods tree, its name filter, and the profile readout — together, because they are
 *  one thing: the view's description is written by exactly one owner (the filter), and the
 *  active profile is what it composes the term around. Split apart, the profile update and a
 *  filter keystroke would race for the same property and the loser would silently vanish. */
export function createModListView(
  modListProvider: ModListProvider,
  modlistSource: Mo2ModlistSource,
  outputChannel: vscode.LogOutputChannel,
): {
  modListView: vscode.TreeView<ModlistNode>; modListFilter: NameFilter; updateProfileDescription: () => Promise<void>;
} {
  const modListView = vscode.window.createTreeView('modbench.modList', {
    treeDataProvider: modListProvider,
    showCollapseAll: true,
    dragAndDropController: modListProvider,
  });
  const modListFilter = registerNameFilter({
    view: modListView,
    viewId: 'modbench.modList',
    placeholder: 'Filter mods…',
    setFilter: (text, grouping) => modListProvider.setFilter(text, grouping),
    // The pinned Overwrite row sits outside all filtering (it is a fixture over the folder, not
    // a modlist entry), so it is not evidence that the term matched anything.
    hasRows: async () => (await modListProvider.getChildren()).some((n) => !(n instanceof OverwriteNode)),
    toggle: { icon: 'list-tree', label: 'Group by separator' },
  });
  const updateProfileDescription = async () => {
    try {
      modListFilter.setBaseDescription(await modlistSource.getActiveProfile());
    } catch (err) {
      outputChannel.error(`[extension] reading active profile failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  void updateProfileDescription();
  return { modListView, modListFilter, updateProfileDescription };
}
/** Downloads sidebar tree: a native TreeView over downloads/.
 *  The row's native `view/item/context` menu commands are registered here too — see
 *  DownloadsPanel.ts' registerDownloadsSingleRowCommands/registerDownloadsMultiRowCommands and
 *  package.json's contributes.menus["view/item/context"]. Returns the live provider (exposed
 *  via activate() for integration tests) alongside its disposables. */
export function registerDownloadsView(
  instanceRoot: string,
  outputChannel: vscode.LogOutputChannel,
): { downloadsProvider: DownloadsProvider; disposables: vscode.Disposable[] } {
  // `log` is a compat shim (defaults to .info) for modules taking a flat `(msg) => void` —
  // constructed here, at the boundary, rather than threaded in as its own parameter alongside
  // outputChannel (#628: finishing the reporter migration means the flat shape stops at the
  // collaborator that still needs it, not one level higher).
  const log = (msg: string) => outputChannel.info(msg);
  const downloadsProvider = new DownloadsProvider(instanceRoot, log);
  const downloadsView = vscode.window.createTreeView('modbench.downloads', {
    treeDataProvider: downloadsProvider,
    canSelectMany: true,
  });
  return {
    downloadsProvider,
    disposables: [
      downloadsView,
      createDownloadsWatcher(instanceRoot, () => downloadsProvider.invalidate()),
      // Dims hidden rows once Show hidden is on — the sole cue distinguishing them,
      // since Show hidden is additive, not an exclusive filter.
      vscode.window.registerFileDecorationProvider(
        new HiddenDownloadDecorationProvider(instanceRoot, () => downloadsProvider.hiddenNames()),
      ),
      registerNameFilter({
        view: downloadsView, viewId: 'modbench.downloads', placeholder: 'Filter downloads…',
        setFilter: (text) => downloadsProvider.setFilter(text),
        hasRows: async () => (await downloadsProvider.getChildren()).length > 0,
      }),
      registerDownloadsSortCommand(downloadsProvider),
      ...registerDownloadsHiddenToggleCommands(downloadsProvider),
      ...registerDownloadsSingleRowCommands(instanceRoot, log),
      ...registerDownloadsMultiRowCommands(instanceRoot, log),
    ],
  };
}
/** Is Modbench itself the deployer? One reading of the setting, shared by the context key that
 *  gates the declarative `when` clauses and by the header's deployment row — two answers that
 *  disagreed would put an icon and its readout in different states. */
export function isStandaloneDeployment(): boolean {
  return (meditConfig().get('mods.deploymentMode') ?? 'external') !== 'external';
}
/** Seed and watch the deployment-mode context key (standalone vs external manager). */
export function registerDeploymentModeContext(
  context: vscode.ExtensionContext,
  // The deployment row appears/disappears with the mode — a narrow callback against the
  // composition root's session object, same reasoning as registerModListCoreCommands's own
  // pair of callbacks above.
  notifyLoadoutHeaderChanged: () => void,
): void {
  // Deploy/Purge/Launch are standalone-only; hidden when an external manager owns
  // deployment. Default external for the alpha — MO2 stays the deployer/launcher
  // until standalone deploy ships post-alpha.
  const applyDeploymentMode = () => {
    void vscode.commands.executeCommand('setContext', 'modbench.deploymentStandalone', isStandaloneDeployment());
  };
  applyDeploymentMode();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('modbench.mods.deploymentMode')) {
        applyDeploymentMode();
        notifyLoadoutHeaderChanged();
      }
    }),
  );
}
/** Deploy / Purge / Launch Game commands (standalone mode). Orchestrates the
 *  existing resolver + deployer over the active MO2 instance; surfacing goes
 *  through an injected reporter per ADR-0026. */
export function registerDeployCommands(
  instanceRoot: string,
  modlistSource: Mo2ModlistSource,
  outputChannel: vscode.LogOutputChannel,
  gameDirResolver: GameDirectoryResolver,
  // The deployment row appears/disappears with a successful deploy/purge — same narrow
  // callback as registerDeploymentModeContext's own, against the session object.
  notifyLoadoutHeaderChanged: () => void,
): vscode.Disposable[] {
  const config = meditConfig;
  const detectPaths = makeDetectPaths();

  const reporter = makeReporter(outputChannel, 'deploy');

  const resolveGd = async () => {
    // The single game-directory resolver, shared with the views/drift tracker/load order
    // launch — memoised and invalidated only when modbench.mods.gameDirectory changes.
    const gd = await gameDirResolver.resolve();
    if (!gd) {
      reporter.report('error', 'No game directory found. Set modbench.mods.gameDirectory to your Stock Game Folder or Steam install.');
    }
    return gd;
  };

  const resolveLoadOrder = async (): Promise<LoadOrderDeployment[]> => {
    const target = (config().get('game.pluginsTxtPath') as string) || (await detectPaths())?.pluginsTxt;
    if (!target) return [];
    const profile = await modlistSource.getActiveProfile();
    return [{ source: path.join(instanceRoot, 'profiles', profile, 'plugins.txt'), target }];
  };

  const runDeploy = async (gd: GameDirectory) => {
    const index = buildFileConflictIndex(await modlistSource.readModlist(), instanceRoot, (msg) => outputChannel.debug(msg));
    await deploy(instanceRoot, gd, await index, reporter, { loadOrder: await resolveLoadOrder() });
  };

  return [
    vscode.commands.registerCommand('modbench.modList.deploy', async () => {
      try {
        const gd = await resolveGd();
        if (!gd) return;
        await runDeploy(gd);
        notifyLoadoutHeaderChanged();
        void vscode.window.showInformationMessage('Modbench: Mods deployed.');
      } catch (err) {
        reporter.report('error', 'Deploy failed.', err instanceof Error ? err.message : String(err));
      }
    }),
    vscode.commands.registerCommand('modbench.modList.purge', async () => {
      try {
        const gd = await resolveGd();
        if (!gd) return;
        await purge(instanceRoot, gd, reporter);
        notifyLoadoutHeaderChanged();
        void vscode.window.showInformationMessage('Modbench: Deployed mods purged.');
      } catch (err) {
        reporter.report('error', 'Purge failed.', err instanceof Error ? err.message : String(err));
      }
    }),
  ];
}
/** Tool launching (not yet landed) contributes one task per entry in MO2's executables registry
 *  under this type; Launch… is the single affordance that runs one of them. Named here so the
 *  future provider has one place to agree with. */
export const LAUNCH_TASK_TYPE = 'modbench';
/** Launch… — one affordance no matter how many executables exist, because the registry
 *  decides what is launchable, not the title bar. It reads the contributed tasks at
 *  invocation (so an executable added in MO2 appears without a reload) and executes the
 *  selection; it never resolves a binary itself — deploying and then spawning a hardcoded
 *  exe would lock the command to one game and conflate two separate operations.
 *
 *  Until tool launching lands there are no such tasks, so this says so rather than guessing
 *  a path. */
export function registerLaunchCommand(outputChannel: vscode.LogOutputChannel): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.launch', async () => {
    const tasks = await vscode.tasks.fetchTasks({ type: LAUNCH_TASK_TYPE });
    if (tasks.length === 0) {
      outputChannel.info('[extension] Launch…: no launchable tasks contributed yet');
      void vscode.window.showInformationMessage(
        'Modbench: No launch targets yet — the executables you configured in MO2 appear here once tool launching lands.',
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      tasks.map((task) => ({ label: task.name, task })),
      { placeHolder: 'Launch' },
    );
    if (!picked) return;
    await vscode.tasks.executeTask(picked.task);
  });
}
