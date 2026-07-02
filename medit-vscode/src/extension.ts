import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { BackendManager } from './BackendManager';
import { createApiClient } from './ApiClient';
import { detectGamePaths } from './GamePathDetector';
import { SessionWizard } from './SessionWizard';
import { SessionController } from './SessionController';
import { LoadMoreNode, PlacedGroupNode, PlacedNode, PluginTreeProvider, RecordNode } from './PluginTreeProvider';
import { ChangeGroupNode, ChangeGroupsTreeProvider } from './ChangeGroupsTreeProvider';
import { ApiPluginRepository } from './PluginRepository';
import { FilterCodeLensProvider } from './FilterCodeLensProvider';
import { buildWebviewHtml } from './webviewHtml';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, type ExtensionToWebview, type WebviewToExtension } from './messages';
import { openReferencedByPanel } from './ReferencedByPanel';
import { Mo2ModlistSource } from './modmanager/mo2/Mo2ModlistSource';
import { ModListProvider, ModNode, SeparatorNode } from './modmanager/ModListProvider';

let backendManager: BackendManager | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const cfg = vscode.workspace.getConfiguration('mEdit');
  const port: number = cfg.get('backendPort') ?? 5172;

  const outputChannel = vscode.window.createOutputChannel('mEdit');
  context.subscriptions.push(outputChannel);
  const log = (msg: string) => outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBarItem);

  backendManager = new BackendManager({
    port,
    log,
    statusBar: {
      setText: (t) => { statusBarItem.text = t; },
      show: () => statusBarItem.show(),
      dispose: () => statusBarItem.dispose(),
    },
  });

  const client = createApiClient(port);
  const repository = new ApiPluginRepository(client, log);
  const treeProvider = new PluginTreeProvider(repository, log);
  const changeGroupTreeProvider = new ChangeGroupsTreeProvider(client, log);
  const openPanels = new Map<string, vscode.WebviewPanel>();

  // Resolve scripts path (config or ~/.medit/scripts)
  const scriptsPathCfg: string = cfg.get('scriptsPath') ?? '';
  const scriptsPath = scriptsPathCfg || path.join(os.homedir(), '.medit', 'scripts');
  fs.mkdirSync(scriptsPath, { recursive: true });

  const pendingChangesSql = path.join(scriptsPath, 'pending-changes.sql');
  const presetSrc = path.join(__dirname, '..', 'extension', 'scripts', 'pending-changes.sql');
  if (!fs.existsSync(pendingChangesSql) && fs.existsSync(presetSrc))
    fs.copyFileSync(presetSrc, pendingChangesSql);

  const filterProvider = new FilterCodeLensProvider(scriptsPath);

  const setFilterActive = (active: boolean, sql?: string) => {
    void vscode.commands.executeCommand('setContext', 'mEdit.filterActive', active);
    filterProvider.setActiveSql(active ? (sql ?? null) : null);
  };

  const controller = new SessionController({
    client,
    repository,
    log,
    makeWizard: () => new SessionWizard({
      client,
      detectPaths: () => {
        const dataOverride: string = cfg.get('game.dataFolderPath') ?? '';
        const pluginsOverride: string = cfg.get('game.pluginsTxtPath') ?? '';
        if (dataOverride && pluginsOverride) {
          return Promise.resolve({ dataFolder: dataOverride, pluginsTxt: pluginsOverride });
        }
        return detectGamePaths();
      },
      showQuickPick: (items) =>
        vscode.window.showQuickPick(items, { placeHolder: 'Select game path' }) as Promise<{ label: string } | undefined>,
      showInputBox: (opts) =>
        vscode.window.showInputBox({ prompt: opts.prompt, value: opts.value }),
      showErrorMessage: (msg) => { void vscode.window.showErrorMessage(msg); },
      showWarningMessage: (msg) => { void vscode.window.showWarningMessage(msg); },
      log,
    }),
    refreshTree: () => treeProvider.refresh(),
    refreshGroupTree: () => changeGroupTreeProvider.refresh(),
    setStatusText: (t) => { statusBarItem.text = t; },
    showWarning: (msg) => { void vscode.window.showWarningMessage(msg); },
    showError: (msg) => { void vscode.window.showErrorMessage(msg); },
    setFilterActive,
  });

  const treeView = vscode.window.createTreeView('mEdit.pluginTree', {
    treeDataProvider: treeProvider,
    canSelectMany: true,
  });

  const changeGroupTreeView = vscode.window.createTreeView('mEdit.changeGroupTree', {
    treeDataProvider: changeGroupTreeProvider,
  });

  // ── Mod List (Loadout) view ──────────────────────────────────────────────────
  // The open workspace root IS the MO2 instance (see medit-vscode/CLAUDE.md). Until
  // the Loadout↔Editing toggle lands (Modbench-5), Mod List is the only visible view.
  void vscode.commands.executeCommand('setContext', 'medit.viewMode', 'loadout');
  const instanceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (instanceRoot) {
    const modlistSource = new Mo2ModlistSource(instanceRoot);
    const modListProvider = new ModListProvider(modlistSource, log, instanceRoot);
    const modListView = vscode.window.createTreeView('mEdit.modList', {
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
        void vscode.window.showErrorMessage(`mEdit: ${failMessage}`);
      }
    };

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
            void vscode.window.showErrorMessage(`mEdit: Failed to update "${node.mod.name}".`);
            modListProvider.refresh();
          }
        }
      }),
      vscode.commands.registerCommand('mEdit.modList.refresh', () => {
        modListProvider.refresh();
        void updateProfileDescription();
      }),
      vscode.commands.registerCommand('mEdit.modList.switchProfile', async () => {
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
      }),
      vscode.commands.registerCommand('mEdit.modList.filter', () => {
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
      vscode.commands.registerCommand('mEdit.modList.launchMedit', () => {
        void vscode.window.showInformationMessage('mEdit: Launch mEdit is wired in Modbench-5.');
      }),
      vscode.commands.registerCommand('mEdit.modList.mod.openInExplorer', async (node: ModNode) => {
        if (node?.kind !== 'mod') return;
        const uri = vscode.Uri.file(path.join(instanceRoot, 'mods', node.mod.name));
        await vscode.commands.executeCommand('revealInExplorer', uri);
      }),
      vscode.commands.registerCommand('mEdit.modList.mod.addSeparatorBelow', async (node: ModNode) => {
        if (node?.kind !== 'mod') return;
        const name = await vscode.window.showInputBox({ prompt: 'Separator name', placeHolder: 'My Group' });
        if (!name) return;
        await runModAction('addSeparatorBelow', 'Failed to add separator.', () => modlistSource.insertSeparator(name, node.mod.name));
      }),
      vscode.commands.registerCommand('mEdit.modList.mod.moveToSeparator', async (node: ModNode) => {
        if (node?.kind !== 'mod') return;
        let separators: string[];
        try {
          const entries = await modlistSource.readModlist();
          separators = entries.filter((e) => e.kind === 'separator').map((e) => e.name);
        } catch (err) {
          log(`[extension] moveToSeparator readModlist failed: ${err instanceof Error ? err.message : String(err)}`);
          void vscode.window.showErrorMessage(`mEdit: Failed to read mod list.`);
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
      vscode.commands.registerCommand('mEdit.modList.mod.uninstall', async (node: ModNode) => {
        if (node?.kind !== 'mod') return;
        const answer = await vscode.window.showWarningMessage(
          `Uninstall "${node.mod.name}"? This will permanently delete the mod folder from disk.`,
          { modal: true },
          'Uninstall',
        );
        if (answer !== 'Uninstall') return;
        await runModAction('uninstall', `Failed to uninstall "${node.mod.name}".`, () => modlistSource.removeMod(node.mod.name));
      }),
      vscode.commands.registerCommand('mEdit.modList.mod.viewOnNexus', async (node: ModNode) => {
        if (node?.kind !== 'mod' || !node.mod.nexusId) return;
        const nexusId = node.mod.nexusId;
        await runModAction('viewOnNexus', 'Failed to open Nexus page.', async () => {
          const slug = await modlistSource.getNexusSlug();
          await vscode.env.openExternal(
            vscode.Uri.parse(`https://www.nexusmods.com/${slug}/mods/${nexusId}`),
          );
        });
      }),
      vscode.commands.registerCommand('mEdit.modList.separator.rename', async (node: SeparatorNode) => {
        if (node?.kind !== 'separator') return;
        const newName = await vscode.window.showInputBox({
          prompt: 'Rename separator',
          value: node.separator.name,
        });
        if (!newName || newName === node.separator.name) return;
        await runModAction('renameSeparator', 'Failed to rename separator.', () => modlistSource.renameSeparator(node.separator.name, newName));
      }),
      vscode.commands.registerCommand('mEdit.modList.separator.addSeparatorBelow', async (node: SeparatorNode) => {
        if (node?.kind !== 'separator') return;
        const name = await vscode.window.showInputBox({ prompt: 'Separator name', placeHolder: 'My Group' });
        if (!name) return;
        await runModAction('separator.addSeparatorBelow', 'Failed to add separator.', () => modlistSource.insertSeparator(name, node.separator.name));
      }),
      vscode.commands.registerCommand('mEdit.modList.separator.delete', async (node: SeparatorNode) => {
        if (node?.kind !== 'separator') return;
        await runModAction('deleteSeparator', 'Failed to delete separator.', () => modlistSource.deleteSeparator(node.separator.name));
      }),
    );
  } else {
    log('[extension] No workspace folder open — Mod List view not registered.');
  }

  context.subscriptions.push(
    treeView,
    changeGroupTreeView,
    vscode.languages.registerCodeLensProvider({ language: 'sql' }, filterProvider),
    vscode.commands.registerCommand('mEdit.refreshTree', () => treeProvider.refresh()),
    vscode.commands.registerCommand('mEdit.loadSession', () => controller.loadSession()),
    vscode.commands.registerCommand('mEdit.reloadSession', () => treeProvider.refresh()),
    vscode.commands.registerCommand('mEdit.openEditor', (args?: { formKey?: string; label?: string }) => {
      openRecordPanel(context, openPanels, args?.label ?? args?.formKey ?? 'mEdit', args?.formKey, port);
    }),
    vscode.commands.registerCommand('mEdit.openCompare', () => {
      openRecordPanel(context, openPanels, 'mEdit', undefined, port);
    }),
    vscode.commands.registerCommand('mEdit.loadMore', (node: LoadMoreNode) => treeProvider.loadMore(node)),
    vscode.commands.registerCommand('mEdit.newPlugin', async () => {
      const name = await promptPluginName();
      if (name) await controller.createPlugin(name);
    }),
    vscode.commands.registerCommand('mEdit.setFilter', async () => {
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
    vscode.commands.registerCommand('mEdit.setFilterFromDocument', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const sql = editor.document.getText();
      await controller.setFilter(sql);
    }),
    vscode.commands.registerCommand('mEdit.clearFilter', () => controller.clearFilter()),
    vscode.commands.registerCommand('mEdit.showReferencedBy', (node?: RecordNode) => {
      if (!node?.record?.formKey) return;
      openReferencedByPanel(
        context, openPanels,
        node.record.formKey, node.record.editorId, port,
        (fk) => { void vscode.commands.executeCommand('mEdit.openEditor', { formKey: fk, label: fk }); },
        (fk) => { openRecordPanel(context, openPanels, fk, fk, port, vscode.ViewColumn.Beside); },
      );
    }),
    vscode.commands.registerCommand('mEdit.deleteRecord', async (item?: RecordNode | PlacedNode, allSelected?: (RecordNode | PlacedNode)[]) => {
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
        vscode.window.showErrorMessage('mEdit: Select one or more records in the tree first.');
        return;
      }
      const names = targets.map(toName).join(', ');
      const label = targets.length === 1 ? `Delete "${names}"?` : `Delete ${targets.length} records?`;
      const answer = await vscode.window.showWarningMessage(label, { modal: true }, 'Delete');
      if (answer !== 'Delete') return;
      await controller.deleteRecords(targets.map(toTarget));
    }),
    vscode.commands.registerCommand('mEdit.saveGroup', async (node: ChangeGroupNode) => {
      if (!node?.groupId) return;
      await controller.saveGroup(node.groupId);
    }),
    vscode.commands.registerCommand('mEdit.revertGroup', async (node: ChangeGroupNode) => {
      if (!node?.groupId) return;
      await controller.revertGroup(node.groupId);
    }),
    vscode.commands.registerCommand('mEdit.saveAllGroups', async () => {
      await controller.saveAllGroups();
    }),
    vscode.commands.registerCommand('mEdit.revertAllGroups', async () => {
      await controller.revertAllGroups();
    }),
    vscode.commands.registerCommand('mEdit.copyAsOverrideInto', async (node?: RecordNode | PlacedNode) => {
      const formKey = node instanceof PlacedNode ? node.placed.formKey : node?.record?.formKey;
      if (!formKey) {
        vscode.window.showErrorMessage('mEdit: No record selected.');
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
    vscode.commands.registerCommand('mEdit.createPlaced', async (node?: PlacedGroupNode) => {
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
  );

  backendManager.on('status', (status) => {
    if (status === 'attached') {
      void controller.onBackendConnected()
        .then(() => controller.syncFilterState())
        .then(() => changeGroupTreeProvider.refresh())
        .catch((err: unknown) => log(`[extension] onBackendConnected failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  });

  await backendManager.connect().catch((err: unknown) => {
    vscode.window.showErrorMessage(`mEdit: Backend failed to start — ${err instanceof Error ? err.message : String(err)}`);
  });
}

export function deactivate() {
  backendManager?.dispose();
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

  const panel = vscode.window.createWebviewPanel('mEdit', title, viewColumn, {
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
        vscode.commands.executeCommand('mEdit.openEditor', { formKey: m.formKey, label: m.formKey });
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
