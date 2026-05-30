import * as vscode from 'vscode';
import * as path from 'path';
import { BackendManager } from './BackendManager';
import { createApiClient, type PluginMetadata } from './ApiClient';
import { detectGamePaths } from './GamePathDetector';
import { SessionWizard } from './SessionWizard';
import { LoadMoreNode, PluginNode, PluginTreeProvider, RecordNode } from './PluginTreeProvider';
import { buildWebviewHtml } from './webviewHtml';

let backendManager: BackendManager | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const cfg = vscode.workspace.getConfiguration('mEdit');
  const port: number = cfg.get('backendPort') ?? 5172;

  // Status bar item (owned by BackendManager)
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBarItem);

  backendManager = new BackendManager({
    port,
    statusBar: {
      setText: (t) => { statusBarItem.text = t; },
      show: () => statusBarItem.show(),
      dispose: () => statusBarItem.dispose(),
    },
    binaryPath: path.join(context.extensionPath, 'backend', 'MEditService.Api'),
  });

  const client = createApiClient(port);
  const treeProvider = new PluginTreeProvider(client);
  const openPanels = new Map<string, vscode.WebviewPanel>();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('mEdit.pluginTree', treeProvider),
    vscode.commands.registerCommand('mEdit.refreshTree', () => treeProvider.refresh()),
    vscode.commands.registerCommand('mEdit.loadSession', async () => {
      const wizard = makeWizard(client, cfg);
      const loaded = await wizard.run();
      if (loaded) {
        backendManager?.setStatus('ready');
        await warnIfEmpty(client);
        treeProvider.refresh();
      }
    }),
    vscode.commands.registerCommand('mEdit.reloadSession', () => {
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand('mEdit.openEditor', (args?: { formKey?: string; label?: string }) => {
      openRecordPanel(context, openPanels, args?.label ?? args?.formKey ?? 'mEdit', args?.formKey, port);
    }),
    vscode.commands.registerCommand('mEdit.openCompare', () => {
      openRecordPanel(context, openPanels, 'mEdit', undefined, port);
    }),
    vscode.commands.registerCommand('mEdit.loadMore', (node: LoadMoreNode) => treeProvider.loadMore(node)),
    vscode.commands.registerCommand('mEdit.newPlugin', async () => {
      await runNewPlugin(port, treeProvider);
    }),
    vscode.commands.registerCommand('mEdit.copyAsOverrideInto', async (node?: RecordNode) => {
      const formKey = node?.record?.formKey;
      if (!formKey) {
        vscode.window.showErrorMessage('mEdit: No record selected.');
        return;
      }
      await runCopyAsOverrideInto(client, port, formKey, treeProvider);
    }),
  );

  // Connection-first lifecycle: connect then run session wizard
  backendManager.on('status', async (status) => {
    if (status === 'attached' || status === 'managed') {
      const wizard = makeWizard(client, cfg);
      const loaded = await wizard.run();
      if (loaded) {
        const { data } = await client.GET('/plugins', {}).catch(() => ({ data: null }));
        const plugins = data as unknown[] | null;
        const count = Array.isArray(plugins) ? plugins.length : 0;
        if (count === 0) {
          await warnIfEmpty(client);
        }
        statusBarItem.text = `$(check) mEdit: Ready (${count} plugins)`;
      } else {
        statusBarItem.text = '$(plug) mEdit: No session';
      }
      treeProvider.refresh();
    }
  });

  await backendManager.connect().catch((err) => {
    vscode.window.showErrorMessage(`mEdit: Backend failed to start — ${err.message}`);
  });
}

async function warnIfEmpty(client: ReturnType<typeof createApiClient>): Promise<void> {
  const { data } = await client.GET('/plugins', {}).catch(() => ({ data: null }));
  const plugins = data as unknown[] | null;
  if (Array.isArray(plugins) && plugins.length === 0) {
    vscode.window.showWarningMessage(
      'mEdit: Session loaded but no plugins were found. ' +
      'Plugins.txt may be listing no plugins (common with vanilla post-NextGen FO4). ' +
      'Use MO2 or add plugins to Plugins.txt manually.'
    );
  }
}

function makeWizard(client: ReturnType<typeof createApiClient>, cfg: vscode.WorkspaceConfiguration) {
  return new SessionWizard({
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
    showErrorMessage: (msg) => vscode.window.showErrorMessage(msg),
  });
}

export function deactivate() {
  backendManager?.dispose();
}

async function runNewPlugin(
  port: number,
  treeProvider: PluginTreeProvider,
): Promise<string | undefined> {
  const name = await vscode.window.showInputBox({
    prompt: 'Enter new plugin name (e.g. MyPatch.esp)',
    validateInput: v => {
      if (!v) return 'Name is required';
      if (!/\.(esp|esm|esl)$/i.test(v)) return 'Extension must be .esp, .esm, or .esl';
      return undefined;
    },
  });
  if (!name) return undefined;

  try {
    const res = await fetch(`http://localhost:${port}/plugins/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const text = await res.text();
      vscode.window.showErrorMessage(`mEdit: Failed to create plugin — ${text}`);
      return undefined;
    }
    treeProvider.refresh();
    return name;
  } catch (err) {
    vscode.window.showErrorMessage(`mEdit: Failed to create plugin — ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

async function runCopyAsOverrideInto(
  client: ReturnType<typeof createApiClient>,
  port: number,
  formKey: string,
  treeProvider: PluginTreeProvider,
): Promise<void> {
  let mutablePlugins: PluginMetadata[] = [];
  try {
    const { data } = await client.GET('/plugins', {});
    const all = (data as PluginMetadata[] | undefined) ?? [];
    mutablePlugins = all.filter(p => !p.isImmutable);
  } catch {
    vscode.window.showErrorMessage('mEdit: Failed to fetch plugins.');
    return;
  }

  const NEW_PLUGIN_LABEL = '$(add) New Plugin…';
  const items: vscode.QuickPickItem[] = [
    { label: NEW_PLUGIN_LABEL, description: 'Create a new plugin and copy into it' },
    ...mutablePlugins.map(p => ({ label: p.name, description: `[${p.loadOrderIndex}]` })),
  ];

  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select target plugin' });
  if (!picked) return;

  let targetPlugin = picked.label;
  if (picked.label === NEW_PLUGIN_LABEL) {
    const created = await runNewPlugin(port, treeProvider);
    if (!created) return;
    targetPlugin = created;
  }

  try {
    const res = await fetch(
      `http://localhost:${port}/records/${encodeURIComponent(formKey)}/copy-to/${encodeURIComponent(targetPlugin)}`,
      { method: 'POST' },
    );
    if (!res.ok) {
      const text = await res.text();
      vscode.window.showErrorMessage(`mEdit: Copy failed — ${text}`);
      return;
    }
    treeProvider.refresh();
  } catch (err) {
    vscode.window.showErrorMessage(`mEdit: Copy failed — ${err instanceof Error ? err.message : String(err)}`);
  }
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
      existing.webview.postMessage({ type: 'loadRecord', formKey });
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
      if (m.type === 'openRecord' && m.formKey) {
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

