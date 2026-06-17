import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { BackendManager } from './BackendManager';
import { createApiClient, type PluginMetadata } from './ApiClient';
import { detectGamePaths } from './GamePathDetector';
import { SessionWizard } from './SessionWizard';
import { SessionController } from './SessionController';
import { LoadMoreNode, PluginTreeProvider, RecordNode } from './PluginTreeProvider';
import { ApiPluginRepository } from './PluginRepository';
import { FilterCodeLensProvider } from './FilterCodeLensProvider';
import { buildWebviewHtml } from './webviewHtml';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, type ExtensionToWebview, type WebviewToExtension } from './messages';
import { openReferencedByPanel } from './ReferencedByPanel';

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
    }),
    refreshTree: () => treeProvider.refresh(),
    setStatusText: (t) => { statusBarItem.text = t; },
    showWarning: (msg) => { void vscode.window.showWarningMessage(msg); },
    showError: (msg) => { void vscode.window.showErrorMessage(msg); },
    setFilterActive,
  });

  const treeView = vscode.window.createTreeView('mEdit.pluginTree', {
    treeDataProvider: treeProvider,
    canSelectMany: true,
  });

  context.subscriptions.push(
    treeView,
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
    vscode.commands.registerCommand('mEdit.deleteRecord', async (item?: RecordNode, allSelected?: RecordNode[]) => {
      let targets: RecordNode[];
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
      const names = targets.map(n => n.record.editorId ?? n.record.formKey).join(', ');
      const label = targets.length === 1 ? `Delete "${names}"?` : `Delete ${targets.length} records?`;
      const answer = await vscode.window.showWarningMessage(label, { modal: true }, 'Delete');
      if (answer !== 'Delete') return;
      await controller.deleteRecords(targets.map(n => ({ formKey: n.record.formKey, plugin: n.record.plugin })));
    }),
    vscode.commands.registerCommand('mEdit.copyAsOverrideInto', async (node?: RecordNode) => {
      const formKey = node?.record?.formKey;
      if (!formKey) {
        vscode.window.showErrorMessage('mEdit: No record selected.');
        return;
      }

      let allPlugins: PluginMetadata[];
      try {
        allPlugins = await controller.getPlugins();
      } catch {
        vscode.window.showErrorMessage('mEdit: Failed to fetch plugins.');
        return;
      }

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
  );

  backendManager.on('status', (status) => {
    if (status === 'attached') {
      void controller.onBackendConnected()
        .then(() => controller.syncFilterState())
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
