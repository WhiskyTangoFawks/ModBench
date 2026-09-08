import * as vscode from 'vscode';
import * as path from 'path';
import { Mo2ModlistSource } from './mo2/Mo2ModlistSource';
import { ModListProvider, ModNode, OverwriteNode, SeparatorNode, type ModlistNode } from './ModListProvider';
import { createOverwriteWatcher } from './overwriteWatcher';
import { OverwriteDecorationProvider } from './OverwriteDecorationProvider';
import { type GameDirectoryResolver } from './gameDirectoryResolver';
import { registerDownloadsHiddenToggleCommands, registerDownloadsMultiRowCommands, registerDownloadsSingleRowCommands, registerDownloadsSortCommand } from './DownloadsPanel';
import { DownloadsProvider } from './DownloadsProvider';
import { HiddenDownloadDecorationProvider } from './HiddenDownloadDecorationProvider';
import type { Instance } from './instance';
import { makeReporter } from '../reporter';
import { registerNameFilter, type NameFilter } from '../nameFilter';
import { meditConfig, makeDetectPaths, setMo2InstanceContext } from '../workspaceConfig';
import {
  createEmptyMod,
  deleteSeparator,
  insertSeparator,
  moveModToSeparator,
  renameSeparator,
  uninstallMod,
} from './commands/modlist';
import { deployMods, purgeMods, type DeploymentCommandResult } from './commands/deployment';
import { installFromArchive, installFromFolder } from './commands/install';
import { switchProfile } from './commands/profile';

// A refusal becomes a throw here, so `runModAction`'s existing catch-and-report keeps its one
// contract whether the failure came from a rejected promise or an `{ applied: false }` result.
function applyOrThrow(outcome: { applied: true } | { applied: false; refusal: string }): void {
  if (!outcome.applied) throw new Error(outcome.refusal);
}


/** Always empty, so VS Code renders the `viewsWelcome` contribution instead of the tree.
 *  `getTreeItem` is unreachable: `getChildren` never yields an element. */
export const NOT_MO2_INSTANCE_PROVIDER: vscode.TreeDataProvider<never> = {
  getTreeItem: () => { throw new Error('unreachable — NOT_MO2_INSTANCE_PROVIDER never yields children'); },
  getChildren: () => [],
};

/** Positional params, not a Deps bundle: a bundle earns its keep by being shared across more
 *  than one call site, not merely by having several fields. The two callbacks are narrow
 *  windows onto the composition root's session object. */
export function registerModListCoreCommands(
  instanceRoot: string, modListProvider: ModListProvider, modlistSource: Mo2ModlistSource,
  outputChannel: vscode.LogOutputChannel, updateProfileDescription: () => Promise<void>,
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
        const outcome = await switchProfile(instanceRoot, picked.label);
        if (!outcome.applied) {
          makeReporter(outputChannel, 'switchProfile').report('error', 'Failed to switch profile.', outcome.refusal);
          return;
        }
        void updateProfileDescription();
        notifyLoadoutHeaderChanged();
        // A profile switch is the next snapshot, not a teardown (ADR-0044). Switching writes
        // ModOrganizer.ini rather than modlist/plugins.txt, the files the sync's own watchers
        // cover, so it is asked for explicitly.
        requestLoadOrderSync();
      }),
  ];
}
export interface ModInstallDeps {
  instanceRoot: string;
  runModAction: (label: string, failMessage: string, action: () => Promise<void>) => Promise<void>;
  promptModName: (defaultName: string) => Thenable<string | undefined>;
  warnIfFomod: (name: string, isFomod: boolean) => void;
}
export function registerModInstallCommands(deps: ModInstallDeps): vscode.Disposable[] {
  const { instanceRoot, runModAction, promptModName, warnIfFomod } = deps;
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
          const outcome = await installFromArchive(instanceRoot, name, resolvedArchive);
          if (!outcome.applied) throw new Error(outcome.refusal);
          warnIfFomod(name, outcome.isFomod);
          succeeded = true;
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
          const outcome = await installFromFolder(instanceRoot, name, folder);
          if (!outcome.applied) throw new Error(outcome.refusal);
          warnIfFomod(name, outcome.isFomod);
        });
      }),
  ];
}
export function registerModContextCommands(
  instanceRoot: string, modlistSource: Mo2ModlistSource, outputChannel: vscode.LogOutputChannel,
  runModAction: (label: string, failMessage: string, action: () => Promise<void>) => Promise<void>,
): vscode.Disposable[] {
  return [
      vscode.commands.registerCommand('modbench.modList.mod.openInExplorer', async (node: ModNode | undefined) => {
        if (node?.kind !== 'mod') return;
        const uri = vscode.Uri.file(path.join(instanceRoot, 'mods', node.mod.name));
        await vscode.commands.executeCommand('revealInExplorer', uri);
      }),
      vscode.commands.registerCommand('modbench.modList.mod.addSeparatorBelow', async (node: ModNode | undefined) => {
        if (node?.kind !== 'mod') return;
        const name = await vscode.window.showInputBox({ prompt: 'Separator name', placeHolder: 'My Group' });
        if (!name) return;
        await runModAction('addSeparatorBelow', 'Failed to add separator.', async () => {
          const profile = await modlistSource.getActiveProfile();
          applyOrThrow(await insertSeparator(instanceRoot, profile, name, node.mod.name));
        });
      }),
      vscode.commands.registerCommand('modbench.modList.mod.moveToSeparator', async (node: ModNode | undefined) => {
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
        await runModAction('moveToSeparator', 'Failed to move mod.', async () => {
          const profile = await modlistSource.getActiveProfile();
          applyOrThrow(await moveModToSeparator(instanceRoot, profile, node.mod.name, picked.sepName));
        });
      }),
      vscode.commands.registerCommand('modbench.modList.mod.uninstall', async (node: ModNode | undefined) => {
        if (node?.kind !== 'mod') return;
        const answer = await vscode.window.showWarningMessage(
          `Uninstall "${node.mod.name}"? This will permanently delete the mod folder from disk.`,
          { modal: true },
          'Uninstall',
        );
        if (answer !== 'Uninstall') return;
        await runModAction('uninstall', `Failed to uninstall "${node.mod.name}".`, async () => {
          const profile = await modlistSource.getActiveProfile();
          applyOrThrow(await uninstallMod(instanceRoot, profile, node.mod.name));
        });
      }),
      vscode.commands.registerCommand('modbench.modList.mod.viewOnNexus', async (node: ModNode | undefined) => {
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
export function registerSeparatorCommands(
  instanceRoot: string, modlistSource: Mo2ModlistSource,
  runModAction: (label: string, failMessage: string, action: () => Promise<void>) => Promise<void>,
): vscode.Disposable[] {
  return [
      vscode.commands.registerCommand('modbench.modList.separator.rename', async (node: SeparatorNode | undefined) => {
        if (node?.kind !== 'separator') return;
        const newName = await vscode.window.showInputBox({
          prompt: 'Rename separator',
          value: node.separator.name,
        });
        if (!newName || newName === node.separator.name) return;
        await runModAction('renameSeparator', 'Failed to rename separator.', async () => {
          const profile = await modlistSource.getActiveProfile();
          applyOrThrow(await renameSeparator(instanceRoot, profile, node.separator.name, newName));
        });
      }),
      vscode.commands.registerCommand('modbench.modList.separator.addSeparatorBelow', async (node: SeparatorNode | undefined) => {
        if (node?.kind !== 'separator') return;
        const name = await vscode.window.showInputBox({ prompt: 'Separator name', placeHolder: 'My Group' });
        if (!name) return;
        await runModAction('separator.addSeparatorBelow', 'Failed to add separator.', async () => {
          const profile = await modlistSource.getActiveProfile();
          applyOrThrow(await insertSeparator(instanceRoot, profile, name, node.separator.name));
        });
      }),
      vscode.commands.registerCommand('modbench.modList.separator.delete', async (node: SeparatorNode | undefined) => {
        if (node?.kind !== 'separator') return;
        await runModAction('deleteSeparator', 'Failed to delete separator.', async () => {
          const profile = await modlistSource.getActiveProfile();
          applyOrThrow(await deleteSeparator(instanceRoot, profile, node.separator.name));
        });
      }),
  ];
}
/** Mods tree title-bar action: a name prompt, refusing a name already in use (ADR-0047 point 6
 *  — the command itself decides the refusal; this only surfaces it). */
export function registerCreateEmptyModCommand(
  instanceRoot: string, modlistSource: Mo2ModlistSource,
  runModAction: (label: string, failMessage: string, action: () => Promise<void>) => Promise<void>,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.modList.newEmptyMod', async () => {
    const name = await vscode.window.showInputBox({ prompt: 'New mod name', placeHolder: 'My New Mod' });
    if (!name) return;
    await runModAction('newEmptyMod', `Failed to create "${name}".`, async () => {
      const profile = await modlistSource.getActiveProfile();
      applyOrThrow(await createEmptyMod(instanceRoot, profile, name));
    });
  });
}
/** A live watcher, so the Mods tree follows `overwrite/` filling and emptying without a manual
 *  refresh, plus the folder's sole action. */
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
    vscode.commands.registerCommand('modbench.modList.overwrite.reveal', async (node: OverwriteNode | undefined) => {
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
/** A real provider would only fail lazily on first read, so the view gets an always-empty stub
 *  and its `viewsWelcome` contribution renders an actionable message instead. */
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
/** Tree, filter and profile readout together, because the view's description has exactly one
 *  owner. Split apart, a profile update and a filter keystroke race for that property and the
 *  loser silently vanishes. */
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
/** Returns the live provider alongside its disposables, so integration tests can reach it.
 *  Rows come entirely from the Instance value (ADR-0047); no own scan or watcher here. */
export function registerDownloadsView(
  instanceRoot: string,
  instance: Pick<Instance, 'value' | 'subscribe' | 'sequence'>,
  outputChannel: vscode.LogOutputChannel,
): { downloadsProvider: DownloadsProvider; disposables: vscode.Disposable[] } {
  // A shim for collaborators still taking a flat `(msg) => void`, built here at the boundary so
  // the flat shape stops at them rather than one level higher.
  const log = (msg: string) => outputChannel.info(msg);
  const downloadsProvider = new DownloadsProvider({ instanceRoot, instance });
  const downloadsView = vscode.window.createTreeView('modbench.downloads', {
    treeDataProvider: downloadsProvider,
    canSelectMany: true,
  });
  return {
    downloadsProvider,
    disposables: [
      downloadsView,
      downloadsProvider, // disposes its Instance subscription
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
/** One reading of the setting, shared by the `when`-clause context key and the header's
 *  deployment row: two answers could put an icon and its readout in different states. */
export function isStandaloneDeployment(): boolean {
  return (meditConfig().get('mods.deploymentMode') ?? 'external') !== 'external';
}
/** Seed and watch the deployment-mode context key (standalone vs external manager). */
export function registerDeploymentModeContext(
  context: vscode.ExtensionContext,
  // The deployment row appears and disappears with the mode.
  notifyLoadoutHeaderChanged: () => void,
): void {
  // Deploy, Purge and Launch are hidden when an external manager owns deployment, which is the
  // alpha default: MO2 stays the deployer until standalone deploy ships.
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
export function registerDeployCommands(
  instanceRoot: string,
  modlistSource: Mo2ModlistSource,
  outputChannel: vscode.LogOutputChannel,
  gameDirResolver: GameDirectoryResolver,
  // The deployment row appears and disappears with a successful deploy or purge.
  notifyLoadoutHeaderChanged: () => void,
): vscode.Disposable[] {
  const detectPaths = makeDetectPaths();
  const reporter = makeReporter(outputChannel, 'deploy');

  const loadOrderTarget = async (): Promise<string | undefined> =>
    meditConfig().get('game.pluginsTxtPath') || (await detectPaths())?.pluginsTxt;

  // `wrote` false means the command reported its own abort, so the success message is withheld
  // rather than announcing a deployment that did not happen.
  const run = async (
    failure: string, success: string, command: () => Promise<DeploymentCommandResult>,
  ): Promise<void> => {
    let outcome: DeploymentCommandResult;
    try {
      outcome = await command();
    } catch (err) {
      outcome = { applied: false, refusal: err instanceof Error ? err.message : String(err) };
    }
    if (!outcome.applied) {
      reporter.report('error', failure, outcome.refusal);
      return;
    }
    if (!outcome.wrote) return;
    void vscode.window.showInformationMessage(success);
    notifyLoadoutHeaderChanged();
  };

  return [
    vscode.commands.registerCommand('modbench.modList.deploy', () =>
      run('Deploy failed.', 'Modbench: Mods deployed.', async () =>
        deployMods(
          instanceRoot,
          await modlistSource.getActiveProfile(),
          // The single game-directory resolver, memoised and invalidated only when
          // modbench.mods.gameDirectory changes.
          (await gameDirResolver.resolve()) ?? undefined,
          await loadOrderTarget(),
          reporter,
          (msg) => outputChannel.debug(msg),
        ))),
    vscode.commands.registerCommand('modbench.modList.purge', () =>
      run('Purge failed.', 'Modbench: Deployed mods purged.', async () =>
        purgeMods(instanceRoot, (await gameDirResolver.resolve()) ?? undefined, reporter))),
  ];
}
/** The task type tool launching contributes one task per MO2 executables-registry entry under.
 *  Named here so the provider and the Launch… command have one place to agree. */
export const LAUNCH_TASK_TYPE = 'modbench';
/** One affordance however many executables exist, because MO2's registry decides what is
 *  launchable. Tasks are read at invocation, so an executable added in MO2 appears without a
 *  reload; resolving a binary here would lock the command to one game. */
export function registerLaunchCommand(outputChannel: vscode.LogOutputChannel): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.launch', async () => {
    const tasks = await vscode.tasks.fetchTasks({ type: LAUNCH_TASK_TYPE });
    if (tasks.length === 0) {
      outputChannel.info('[extension] Launch…: no launchable tasks contributed');
      void vscode.window.showInformationMessage(
        'Modbench: No launch targets — add an executable to MO2\'s executables list and it appears here.',
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
