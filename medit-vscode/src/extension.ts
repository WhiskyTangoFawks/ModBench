import * as vscode from 'vscode';
import * as path from 'path';
import { BackendManager } from './BackendManager';
import { createApiClient, type PluginMetadata } from './ApiClient';
import { detectGamePaths } from './GamePathDetector';
import { SessionWizard } from './SessionWizard';
import { SessionController } from './SessionController';
import { LoadMoreNode, PluginTreeProvider, RecordNode } from './PluginTreeProvider';
import { ApiPluginRepository } from './PluginRepository';
import { buildWebviewHtml } from './webviewHtml';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from './messages';

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
  const treeProvider = new PluginTreeProvider(new ApiPluginRepository(client, log), log);
  const openPanels = new Map<string, vscode.WebviewPanel>();

  const controller = new SessionController({
    client,
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
  });

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('mEdit.pluginTree', treeProvider),
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
      void controller.onBackendConnected();
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
) {
  const existing = openPanels.get(RECORD_PANEL_KEY);
  if (existing) {
    existing.title = title;
    existing.reveal();
    if (formKey) {
      existing.webview.postMessage({ type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey });
    }
    return;
  }

  const panel = vscode.window.createWebviewPanel('mEdit', title, vscode.ViewColumn.One, {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'out', 'webview'))],
  });

  openPanels.set(RECORD_PANEL_KEY, panel);
  panel.onDidDispose(() => openPanels.delete(RECORD_PANEL_KEY));

  panel.webview.onDidReceiveMessage((msg: unknown) => {
    if (typeof msg === 'object' && msg !== null && 'type' in msg) {
      const m = msg as { type: string; formKey?: string; label?: string };
      if (m.type === WEBVIEW_TO_EXTENSION.OPEN_RECORD && m.formKey) {
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
