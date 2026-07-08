import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as cp from 'child_process';
import { BackendManager } from './medit/BackendManager';
import { createApiClient } from './medit/ApiClient';
import { detectGamePaths } from './medit/GamePathDetector';
import { SessionController } from './medit/SessionController';
import { LoadMoreNode, PlacedGroupNode, PlacedNode, PluginTreeNode, PluginTreeProvider, RecordNode } from './medit/PluginTreeProvider';
import { ChangeGroupNode, ChangeGroupsTreeProvider } from './medit/ChangeGroupsTreeProvider';
import { ApiPluginRepository } from './medit/PluginRepository';
import { FilterCodeLensProvider } from './medit/FilterCodeLensProvider';
import { buildWebviewHtml } from './medit/webviewHtml';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, type ExtensionToWebview, type WebviewToExtension } from './medit/messages';
import { openReferencedByPanel } from './medit/ReferencedByPanel';
import { Mo2ModlistSource } from './modmanager/mo2/Mo2ModlistSource';
import { ModListProvider, ModNode, SeparatorNode } from './modmanager/ModListProvider';
import { resolveGameDirectory, type GameDirectory, type DetectPaths } from './modmanager/gameDirectory';
import { deploy, purge, type LoadOrderDeployment, type Reporter } from './modmanager/deployer';
import { buildFileConflictIndex } from './modmanager/fileConflictIndex';
import { buildExplicitPlugins } from './modmanager/explicitSession';
import { detectRoot } from './modmanager/install/detectRoot';
import { extractArchive } from './modmanager/install/extractArchive';

let backendManager: BackendManager | undefined;

const meditConfig = () => vscode.workspace.getConfiguration('modbench');

/** Leave editing: show the Loadout view and tear down the editing backend. */
function exitToLoadout(): void {
  void vscode.commands.executeCommand('setContext', 'modbench.viewMode', 'loadout');
  backendManager?.stop();
}

/** ADR-0026 surfacing reporter: logs always, shows a toast for warning/error. */
function makeReporter(log: (msg: string) => void, tag: string): Reporter {
  return {
    report: (severity, message, detail) => {
      const suffix = detail ? ` — ${detail}` : '';
      log(`[${tag}] ${severity}: ${message}${suffix}`);
      if (severity === 'error') void vscode.window.showErrorMessage(`Modbench: ${message}`);
      else void vscode.window.showWarningMessage(`Modbench: ${message}`);
    },
  };
}

/** Game-path resolver: explicit `game.*` overrides if both set, else autodetect.
 *  Shared by the session wizard, the deploy commands, and editing launch. */
function makeDetectPaths(): DetectPaths {
  return () => {
    const c = meditConfig();
    const dataOverride = (c.get('game.dataFolderPath') as string) ?? '';
    const pluginsOverride = (c.get('game.pluginsTxtPath') as string) ?? '';
    if (dataOverride && pluginsOverride) {
      return Promise.resolve({ dataFolder: dataOverride, pluginsTxt: pluginsOverride });
    }
    return detectGamePaths();
  };
}

export function activate(context: vscode.ExtensionContext) {
  const cfg = vscode.workspace.getConfiguration('modbench');
  const port: number = cfg.get('backendPort') ?? 5172;

  const outputChannel = vscode.window.createOutputChannel('Modbench');
  context.subscriptions.push(outputChannel);
  const log = (msg: string) => outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBarItem);

  backendManager = createBackendManager(port, log, statusBarItem);

  const client = createApiClient(port);
  const repository = new ApiPluginRepository(client, log);
  const treeProvider = new PluginTreeProvider(repository, log);
  const changeGroupTreeProvider = new ChangeGroupsTreeProvider(client, log);
  const openPanels = new Map<string, vscode.WebviewPanel>();

  const { scriptsPath, filterProvider } = setupScripts(cfg);

  const setFilterActive = (active: boolean, sql?: string) => {
    void vscode.commands.executeCommand('setContext', 'modbench.filterActive', active);
    filterProvider.setActiveSql(active ? (sql ?? null) : null);
  };

  const controller = new SessionController({
    client,
    repository,
    log,
    refreshTree: () => treeProvider.refresh(),
    refreshGroupTree: () => changeGroupTreeProvider.refresh(),
    setStatusText: (t) => { statusBarItem.text = t; },
    showWarning: (msg) => { void vscode.window.showWarningMessage(msg); },
    showError: (msg) => { void vscode.window.showErrorMessage(msg); },
    setFilterActive,
  });

  const treeView = vscode.window.createTreeView('modbench.pluginTree', {
    treeDataProvider: treeProvider,
    canSelectMany: true,
  });

  const changeGroupTreeView = vscode.window.createTreeView('modbench.changeGroupTree', {
    treeDataProvider: changeGroupTreeProvider,
  });

  // ── Mod List (Loadout) view ──────────────────────────────────────────────────
  // The open workspace root IS the MO2 instance (see modbench/CLAUDE.md). Until
  // the Loadout↔Editing toggle lands (Modbench-5), Mod List is the only visible view.
  void vscode.commands.executeCommand('setContext', 'modbench.viewMode', 'loadout');

  registerDeploymentModeContext(context);

  registerLoadoutView({ context, log, controller, changeGroupTreeProvider });

  context.subscriptions.push(
    treeView,
    changeGroupTreeView,
    vscode.languages.registerCodeLensProvider({ language: 'sql' }, filterProvider),
    ...registerEditorCommands({ context, openPanels, port, treeProvider, treeView, controller, repository, scriptsPath }),
  );

  // The backend is now spawned lazily on entering editing (Launch mEdit) and
  // torn down on Close mEdit — the extension owns its lifecycle (ADR-0022). There
  // is no auto-connect / auto-wizard at activation; show a neutral idle state.
  statusBarItem.text = '$(plug) mEdit';
}


interface EditorCommandDeps {
  context: vscode.ExtensionContext;
  openPanels: Map<string, vscode.WebviewPanel>;
  port: number;
  treeProvider: PluginTreeProvider;
  treeView: vscode.TreeView<PluginTreeNode>;
  controller: SessionController;
  repository: ApiPluginRepository;
  scriptsPath: string;
}

/** Editor-side commands, grouped so no single registrar exceeds the size budget. */
function registerEditorCommands(deps: EditorCommandDeps): vscode.Disposable[] {
  return [
    ...registerRecordViewCommands(deps),
    ...registerChangeGroupCommands(deps),
    ...registerCopyCreateCommands(deps),
  ];
}

/** Record view/navigation + filter commands. */
function registerRecordViewCommands(deps: EditorCommandDeps): vscode.Disposable[] {
  const { context, openPanels, port, treeProvider, controller, scriptsPath } = deps;
  return [
    vscode.commands.registerCommand('modbench.refreshTree', () => treeProvider.refresh()),
    vscode.commands.registerCommand('modbench.closeMedit', () => exitToLoadout()),
    vscode.commands.registerCommand('modbench.reloadSession', () => treeProvider.refresh()),
    vscode.commands.registerCommand('modbench.openEditor', (args?: { formKey?: string; label?: string }) => {
      openRecordPanel(context, openPanels, args?.label ?? args?.formKey ?? 'mEdit', args?.formKey, port);
    }),
    vscode.commands.registerCommand('modbench.openCompare', () => {
      openRecordPanel(context, openPanels, 'mEdit', undefined, port);
    }),
    vscode.commands.registerCommand('modbench.loadMore', (node: LoadMoreNode) => treeProvider.loadMore(node)),
    vscode.commands.registerCommand('modbench.newPlugin', async () => {
      const name = await promptPluginName();
      if (name) await controller.createPlugin(name);
    }),
    vscode.commands.registerCommand('modbench.setFilter', async () => {
      const files = fs.existsSync(scriptsPath)
        ? fs.readdirSync(scriptsPath).filter(f => f.endsWith('.sql'))
        : [];
      const NEW_FILTER_LABEL = '$(add) New filter…';
      const items: vscode.QuickPickItem[] = [
        ...files.map(f => ({ label: f, description: scriptsPath })),
        { label: NEW_FILTER_LABEL },
      ];
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select .sql filter file' });
      if (!picked) return;
      if (picked.label === NEW_FILTER_LABEL) {
        const doc = await vscode.workspace.openTextDocument({ language: 'sql' });
        await vscode.window.showTextDocument(doc);
        return;
      }
      const filePath = path.join(scriptsPath, picked.label);
      const sql = fs.readFileSync(filePath, 'utf8');
      await controller.setFilter(sql);
    }),
    vscode.commands.registerCommand('modbench.setFilterFromDocument', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const sql = editor.document.getText();
      await controller.setFilter(sql);
    }),
    vscode.commands.registerCommand('modbench.clearFilter', () => controller.clearFilter()),
    vscode.commands.registerCommand('modbench.showReferencedBy', (node?: RecordNode) => {
      if (!node?.record?.formKey) return;
      openReferencedByPanel(
        context, openPanels,
        node.record.formKey, node.record.editorId, port,
        (fk) => { void vscode.commands.executeCommand('modbench.openEditor', { formKey: fk, label: fk }); },
        (fk) => { openRecordPanel(context, openPanels, fk, fk, port, vscode.ViewColumn.Beside); },
      );
    }),
  ];
}

/** Delete records and save/revert change groups. */
function registerChangeGroupCommands(deps: EditorCommandDeps): vscode.Disposable[] {
  const { treeView, controller } = deps;
  return [
    vscode.commands.registerCommand('modbench.deleteRecord', async (item?: RecordNode | PlacedNode, allSelected?: (RecordNode | PlacedNode)[]) => {
      const toTarget = (n: RecordNode | PlacedNode) =>
        n instanceof PlacedNode
          ? { formKey: n.placed.formKey ?? '', plugin: n.plugin }
          : { formKey: n.record.formKey, plugin: n.record.plugin };
      const toName = (n: RecordNode | PlacedNode) =>
        n instanceof PlacedNode
          ? (n.placed.editorId ?? n.placed.formKey ?? '')
          : (n.record.editorId ?? n.record.formKey);

      let targets: (RecordNode | PlacedNode)[];
      if (allSelected?.length) {
        targets = allSelected;
      } else {
        const sel = treeView.selection.filter((n): n is RecordNode => n instanceof RecordNode);
        targets = sel.length ? sel : item ? [item] : [];
      }
      if (targets.length === 0) {
        vscode.window.showErrorMessage('Modbench: Select one or more records in the tree first.');
        return;
      }
      const names = targets.map(toName).join(', ');
      const label = targets.length === 1 ? `Delete "${names}"?` : `Delete ${targets.length} records?`;
      const answer = await vscode.window.showWarningMessage(label, { modal: true }, 'Delete');
      if (answer !== 'Delete') return;
      await controller.deleteRecords(targets.map(toTarget));
    }),
    vscode.commands.registerCommand('modbench.saveGroup', async (node: ChangeGroupNode) => {
      if (!node?.groupId) return;
      await controller.saveGroup(node.groupId);
    }),
    vscode.commands.registerCommand('modbench.revertGroup', async (node: ChangeGroupNode) => {
      if (!node?.groupId) return;
      await controller.revertGroup(node.groupId);
    }),
    vscode.commands.registerCommand('modbench.saveAllGroups', async () => {
      await controller.saveAllGroups();
    }),
    vscode.commands.registerCommand('modbench.revertAllGroups', async () => {
      await controller.revertAllGroups();
    }),
  ];
}

/** Copy-as-override and create-placed record commands. */
function registerCopyCreateCommands(deps: EditorCommandDeps): vscode.Disposable[] {
  const { repository, controller } = deps;
  return [
    vscode.commands.registerCommand('modbench.copyAsOverrideInto', async (node?: RecordNode | PlacedNode) => {
      const formKey = node instanceof PlacedNode ? node.placed.formKey : node?.record?.formKey;
      if (!formKey) {
        vscode.window.showErrorMessage('Modbench: No record selected.');
        return;
      }

      const allPlugins = await repository.getPlugins();
      const mutablePlugins = allPlugins.filter(p => !p.isImmutable);
      const NEW_PLUGIN_LABEL = '$(add) New Plugin…';
      const items: vscode.QuickPickItem[] = [
        { label: NEW_PLUGIN_LABEL, description: 'Create a new plugin and copy into it' },
        ...mutablePlugins.map(p => ({ label: p.name, description: `[${p.loadOrderIndex}]` })),
      ];

      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select target plugin' });
      if (!picked) return;

      let targetPlugin = picked.label;
      if (picked.label === NEW_PLUGIN_LABEL) {
        const name = await promptPluginName();
        if (!name) return;
        await controller.createPlugin(name);
        targetPlugin = name;
      }

      await controller.copyRecordTo(formKey, targetPlugin);
    }),
    vscode.commands.registerCommand('modbench.createPlaced', async (node?: PlacedGroupNode) => {
      if (!node) return;
      const recordType = await vscode.window.showQuickPick(
        [{ label: 'REFR', description: 'Placed object' }, { label: 'ACHR', description: 'Placed actor' }],
        { placeHolder: 'Select placed record type' },
      );
      if (!recordType) return;
      const templateFormKey = await vscode.window.showInputBox({
        prompt: 'Template FormKey (optional — leave blank for empty record)',
        placeHolder: 'e.g. 000001A4:Fallout4.esm',
      });
      await controller.createPlaced(
        node.plugin, node.cellFormKey, recordType.label.toLowerCase(),
        node.group, templateFormKey || undefined,
      );
    }),
  ];
}


interface ModListCoreDeps {
  modListProvider: ModListProvider;
  modlistSource: Mo2ModlistSource;
  updateProfileDescription: () => Promise<void>;
  enterEditing: () => Promise<void>;
  log: (msg: string) => void;
}
/** Loadout core commands: refresh, switch profile, filter, launch mEdit. */
function registerModListCoreCommands(deps: ModListCoreDeps): vscode.Disposable[] {
  const { modListProvider, modlistSource, updateProfileDescription, enterEditing, log } = deps;
  return [
      vscode.commands.registerCommand('modbench.modList.refresh', () => {
        modListProvider.refresh();
        void updateProfileDescription();
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
        // New session boundary — tear down any live editing backend so a stale
        // session can't survive the profile change (no-op if already stopped).
        exitToLoadout();
        await modListProvider.switchProfile(picked.label);
        void updateProfileDescription();
      }),
      vscode.commands.registerCommand('modbench.modList.filter', () => {
        const box = vscode.window.createInputBox();
        box.placeholder = 'Filter mods…';
        let grouping = true;
        const updateBtn = () => {
          box.buttons = [{ iconPath: new vscode.ThemeIcon('list-tree'), tooltip: `Group by separator (${grouping ? 'on' : 'off'})` }];
        };
        updateBtn();
        box.onDidTriggerButton(() => {
          grouping = !grouping;
          updateBtn();
          modListProvider.setFilter(box.value, grouping);
        });
        box.onDidChangeValue((text) => modListProvider.setFilter(text, grouping));
        box.onDidHide(() => { modListProvider.setFilter('', true); box.dispose(); });
        box.show();
      }),
      vscode.commands.registerCommand('modbench.modList.launchMedit', async () => {
        void vscode.commands.executeCommand('setContext', 'modbench.viewMode', 'editing');
        try {
          await enterEditing();
        } catch (err) {
          log(`[extension] launchMedit failed: ${err instanceof Error ? err.message : String(err)}`);
          exitToLoadout(); // reset the view and tear down any half-started backend
          void vscode.window.showErrorMessage('Modbench: Failed to enter editing mode.');
        }
      }),
  ];
}

interface ModInstallDeps {
  modlistSource: Mo2ModlistSource;
  runModAction: (label: string, failMessage: string, action: () => Promise<void>) => Promise<void>;
  promptModName: (defaultName: string) => Thenable<string | undefined>;
  warnIfFomod: (name: string, isFomod: boolean) => void;
}
/** Loadout install commands: from archive, from folder. */
function registerModInstallCommands(deps: ModInstallDeps): vscode.Disposable[] {
  const { modlistSource, runModAction, promptModName, warnIfFomod } = deps;
  return [
      vscode.commands.registerCommand('modbench.modList.installFromArchive', async () => {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { 'Mod archives': ['zip', '7z', 'rar'] },
          openLabel: 'Install',
        });
        const archive = picked?.[0]?.fsPath;
        if (!archive) return;
        const name = await promptModName(path.basename(archive).replace(/\.(zip|7z|rar)$/i, ''));
        if (!name) return;
        await runModAction('installFromArchive', `Failed to install "${name}".`, async () => {
          const staging = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'medit-install-'));
          try {
            await extractArchive(archive, staging);
            const { sourceDir, isFomod } = await detectRoot(staging);
            await modlistSource.installMod(name, sourceDir, { installationFile: path.basename(archive) });
            warnIfFomod(name, isFomod);
          } finally {
            await fs.promises.rm(staging, { recursive: true, force: true });
          }
        });
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

interface ModContextDeps {
  instanceRoot: string;
  modlistSource: Mo2ModlistSource;
  log: (msg: string) => void;
  runModAction: (label: string, failMessage: string, action: () => Promise<void>) => Promise<void>;
}
/** Loadout per-mod context commands: reveal, separator ops, uninstall, Nexus. */
function registerModContextCommands(deps: ModContextDeps): vscode.Disposable[] {
  const { instanceRoot, modlistSource, log, runModAction } = deps;
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
          log(`[extension] moveToSeparator listSeparators failed: ${err instanceof Error ? err.message : String(err)}`);
          void vscode.window.showErrorMessage(`Modbench: Failed to read mod list.`);
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

interface SeparatorCmdDeps {
  modlistSource: Mo2ModlistSource;
  runModAction: (label: string, failMessage: string, action: () => Promise<void>) => Promise<void>;
}
/** Loadout separator context commands: rename, add-below, delete. */
function registerSeparatorCommands(deps: SeparatorCmdDeps): vscode.Disposable[] {
  const { modlistSource, runModAction } = deps;
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


interface LoadoutViewDeps {
  context: vscode.ExtensionContext;
  log: (msg: string) => void;
  controller: SessionController;
  changeGroupTreeProvider: ChangeGroupsTreeProvider;
}
/** Register the Loadout (Mod List) view and its commands. No-op with a neutral log
 *  when no workspace (MO2 instance) is open. */
function registerLoadoutView(deps: LoadoutViewDeps): void {
  const { context, log, controller, changeGroupTreeProvider } = deps;
  const instanceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!instanceRoot) {
    log('[extension] No workspace folder open — Mod List view not registered.');
    return;
  }
    const modListReporter = makeReporter(log, 'modList');
    const modlistSource = new Mo2ModlistSource(instanceRoot, log, modListReporter);
    const modListProvider = new ModListProvider(modlistSource, log, instanceRoot, modListReporter);
    const modListView = vscode.window.createTreeView('modbench.modList', {
      treeDataProvider: modListProvider,
      showCollapseAll: true,
      dragAndDropController: modListProvider,
    });

    const updateProfileDescription = async () => {
      try {
        modListView.description = await modlistSource.getActiveProfile();
      } catch (err) {
        log(`[extension] reading active profile failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    void updateProfileDescription();

    const runModAction = async (logLabel: string, failMessage: string, action: () => Promise<void>) => {
      try {
        await action();
        modListProvider.refresh();
      } catch (err) {
        log(`[extension] ${logLabel} failed: ${err instanceof Error ? err.message : String(err)}`);
        void vscode.window.showErrorMessage(`Modbench: ${failMessage}`);
      }
    };

    /** Prompt for a mod name, defaulting to the archive/folder basename. */
    const promptModName = (defaultName: string): Thenable<string | undefined> =>
      vscode.window.showInputBox({ prompt: 'Mod name', value: defaultName });

    const warnIfFomod = (name: string, isFomod: boolean): void => {
      if (isFomod)
        void vscode.window.showWarningMessage(
          `Modbench: "${name}" is a FOMOD installer — its files were copied as-is and need manual ` +
            `arrangement (the scripted installer is coming later).`,
        );
    };
    const enterEditing = makeEnterEditing({ instanceRoot, modlistSource, controller, changeGroupTreeProvider });

    backendManager!.on('restarted', () => {
      void enterEditing().catch((err: unknown) =>
        log(`[extension] reload after backend restart failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    });

    context.subscriptions.push(
      modListView,
      modListView.onDidChangeCheckboxState(async (e) => {
        for (const [node, state] of e.items) {
          if (node.kind !== 'mod') continue;
          try {
            await modListProvider.setModEnabled(node.mod.name, state === vscode.TreeItemCheckboxState.Checked);
          } catch (err) {
            // ADR-0026: a failed user action must surface, not silently leave the checkbox
            // out of sync with disk. Log detail, notify, and refresh to resync the checkbox.
            log(`[extension] toggling "${node.mod.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
            void vscode.window.showErrorMessage(`Modbench: Failed to update "${node.mod.name}".`);
            modListProvider.refresh();
          }
        }
      }),
      ...registerModListCoreCommands({ modListProvider, modlistSource, updateProfileDescription, enterEditing, log }),
      ...registerDeployCommands(instanceRoot, modlistSource, log),
      ...registerModInstallCommands({ modlistSource, runModAction, promptModName, warnIfFomod }),
      ...registerModContextCommands({ instanceRoot, modlistSource, log, runModAction }),
      ...registerSeparatorCommands({ modlistSource, runModAction }),
    );
}

interface EnterEditingDeps {
  instanceRoot: string;
  modlistSource: Mo2ModlistSource;
  controller: SessionController;
  changeGroupTreeProvider: ChangeGroupsTreeProvider;
}
/** Build the enter-editing action: spawn/attach the backend and load the active
 *  modlist as a load-explicit session. Also the crash-restart reload path. */
function makeEnterEditing(deps: EnterEditingDeps): () => Promise<void> {
  const { instanceRoot, modlistSource, controller, changeGroupTreeProvider } = deps;
  return async (): Promise<void> => {
      const gd = await resolveGameDirectory(instanceRoot, meditConfig(), makeDetectPaths());
      if (!gd) {
        exitToLoadout(); // don't strand the UI in an empty editing view
        void vscode.window.showErrorMessage(
          'Modbench: No game directory found. Set modbench.mods.gameDirectory to your Stock Game Folder or Steam install.',
        );
        return;
      }
      // Spawn/attach the backend and walk the mod tree concurrently — independent
      // work; the health gate is applied after they join.
      const [, plugins] = await Promise.all([
        backendManager!.start(),
        buildExplicitPlugins(modlistSource, instanceRoot, gd.dataFolder),
      ]);
      if (!backendManager!.isHealthy) {
        exitToLoadout(); // tear down the half-started backend and reset the view
        void vscode.window.showErrorMessage('Modbench: Backend failed to start — see the Modbench output for details.');
        return;
      }
      await controller.loadExplicitSession(plugins, gd.dataFolder);
      await controller.syncFilterState();
      changeGroupTreeProvider.refresh();
  };
}


/** Construct the editing backend manager wired to the bundled binary + status bar. */
function createBackendManager(port: number, log: (msg: string) => void, statusBarItem: vscode.StatusBarItem): BackendManager {
  // Bundled backend binary (see build:backend / .vscodeignore). __dirname is
  // out/ at runtime; the published self-contained executable lives in backend/.
  const backendExe = process.platform === 'win32' ? 'MEditService.Api.exe' : 'MEditService.Api';
  return new BackendManager({
    port,
    log,
    executablePath: path.join(__dirname, '..', 'backend', backendExe),
    spawn: (exe, args) => cp.spawn(exe, args, { detached: false, stdio: 'ignore' }),
    statusBar: {
      setText: (t) => { statusBarItem.text = t; },
      show: () => statusBarItem.show(),
      dispose: () => statusBarItem.dispose(),
    },
  });
}

/** Resolve the scripts dir (config or ~/.medit/scripts), seed the preset filter,
 *  and build the filter CodeLens provider over it. */
function setupScripts(cfg: vscode.WorkspaceConfiguration): { scriptsPath: string; filterProvider: FilterCodeLensProvider } {
  // Resolve scripts path (config or ~/.medit/scripts)
  const scriptsPathCfg: string = cfg.get('scriptsPath') ?? '';
  const scriptsPath = scriptsPathCfg || path.join(os.homedir(), '.medit', 'scripts');
  fs.mkdirSync(scriptsPath, { recursive: true });

  const pendingChangesSql = path.join(scriptsPath, 'pending-changes.sql');
  const presetSrc = path.join(__dirname, '..', 'extension', 'scripts', 'pending-changes.sql');
  if (!fs.existsSync(pendingChangesSql) && fs.existsSync(presetSrc))
    fs.copyFileSync(presetSrc, pendingChangesSql);

  const filterProvider = new FilterCodeLensProvider(scriptsPath);
  return { scriptsPath, filterProvider };
}

/** Seed and watch the deployment-mode context key (standalone vs external manager). */
function registerDeploymentModeContext(context: vscode.ExtensionContext): void {
  // Deploy/Purge/Launch are standalone-only; hidden when an external manager owns
  // deployment. Default standalone (the mechanism on Linux, where USVFS is absent).
  const applyDeploymentMode = () => {
    const mode = vscode.workspace.getConfiguration('modbench').get('mods.deploymentMode') ?? 'standalone';
    void vscode.commands.executeCommand('setContext', 'modbench.deploymentStandalone', mode !== 'external');
  };
  applyDeploymentMode();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('modbench.mods.deploymentMode')) applyDeploymentMode();
    }),
  );
}

export function deactivate() {
  backendManager?.dispose();
}

/** Deploy / Purge / Launch Game commands (standalone mode). Orchestrates the
 *  existing resolver + deployer over the active MO2 instance; surfacing goes
 *  through an injected reporter per ADR-0026. */
function registerDeployCommands(
  instanceRoot: string,
  modlistSource: Mo2ModlistSource,
  log: (msg: string) => void,
): vscode.Disposable[] {
  const config = meditConfig;
  const detectPaths = makeDetectPaths();

  const reporter = makeReporter(log, 'deploy');

  const resolveGd = async () => {
    const gd = await resolveGameDirectory(instanceRoot, config(), detectPaths);
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
    const index = buildFileConflictIndex(await modlistSource.readModlist(), instanceRoot);
    await deploy(instanceRoot, gd, await index, reporter, { loadOrder: await resolveLoadOrder() });
  };

  return [
    vscode.commands.registerCommand('modbench.modList.deploy', async () => {
      try {
        const gd = await resolveGd();
        if (!gd) return;
        await runDeploy(gd);
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
        void vscode.window.showInformationMessage('Modbench: Deployed mods purged.');
      } catch (err) {
        reporter.report('error', 'Purge failed.', err instanceof Error ? err.message : String(err));
      }
    }),
    vscode.commands.registerCommand('modbench.modList.launchGame', async () => {
      try {
        const gd = await resolveGd();
        if (!gd) return;
        await runDeploy(gd);
        // Switch to the Plugin List view while the game runs (mirrors launchMedit).
        void vscode.commands.executeCommand('setContext', 'modbench.viewMode', 'editing');
        const executable = path.join(gd.root, 'Fallout4.exe');
        const template = (config().get('mods.launchCommand') as string) || '';
        const child = template
          ? cp.spawn(template.replaceAll('${executable}', executable), { shell: true, cwd: gd.root, detached: true, stdio: 'ignore' })
          : cp.spawn(executable, { cwd: gd.root, detached: true, stdio: 'ignore' });
        child.on('error', (e) => reporter.report('error', 'Failed to launch the game.', e.message));
        child.on('exit', () => {
          void purge(instanceRoot, gd, reporter).catch((e) => log(`[deploy] purge on exit failed: ${String(e)}`));
        });
      } catch (err) {
        reporter.report('error', 'Launch Game failed.', err instanceof Error ? err.message : String(err));
      }
    }),
  ];
}

function promptPluginName(): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    prompt: 'Enter new plugin name (e.g. MyPatch.esp)',
    validateInput: v => {
      if (!v) return 'Name is required';
      if (!/\.(esp|esm|esl)$/i.test(v)) return 'Extension must be .esp, .esm, or .esl';
      return undefined;
    },
  });
}

const RECORD_PANEL_KEY = '__record_view__';

function openRecordPanel(
  context: vscode.ExtensionContext,
  openPanels: Map<string, vscode.WebviewPanel>,
  title: string,
  formKey: string | undefined,
  port: number,
  viewColumn: vscode.ViewColumn = vscode.ViewColumn.One,
) {
  if (viewColumn !== vscode.ViewColumn.Beside) {
    const existing = openPanels.get(RECORD_PANEL_KEY);
    if (existing) {
      existing.title = title;
      existing.reveal();
      if (formKey) {
        existing.webview.postMessage({ type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey } satisfies ExtensionToWebview);
      }
      return;
    }
  }

  const panel = vscode.window.createWebviewPanel('modbench', title, viewColumn, {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'out', 'webview'))],
  });

  if (viewColumn !== vscode.ViewColumn.Beside) {
    openPanels.set(RECORD_PANEL_KEY, panel);
    panel.onDidDispose(() => openPanels.delete(RECORD_PANEL_KEY));
  }

  panel.webview.onDidReceiveMessage((msg: unknown) => {
    if (typeof msg === 'object' && msg !== null && 'type' in msg) {
      const m = msg as WebviewToExtension;
      if (m.type === WEBVIEW_TO_EXTENSION.OPEN_RECORD) {
        vscode.commands.executeCommand('modbench.openEditor', { formKey: m.formKey, label: m.formKey });
      }
    }
  });

  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.file(path.join(context.extensionPath, 'out', 'webview', 'assets', 'main.js'))
  );

  panel.webview.html = buildWebviewHtml({
    formKey,
    port,
    scriptUri: scriptUri.toString(),
    cspSource: panel.webview.cspSource,
  });
}
