import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MEditClient, RecordFilter } from '../client';
import type { Reporter } from '../ports/reporter';
import type { InteriorLoadMoreNode, PluginTreeProvider } from './PluginTreeProvider';

// The row's own load-more gesture: a partial record page grew a synthetic "load more" leaf, and
// this is the only thing that leaf's click does.
export function registerLoadMoreCommand(treeProvider: PluginTreeProvider): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.loadMore', (node: InteriorLoadMoreNode) => treeProvider.loadMore(node));
}

export interface FilterCommandDeps {
  scriptsPath: string;
  client: Pick<MEditClient, 'setFilter' | 'clearFilter'>;
  treeProvider: Pick<PluginTreeProvider, 'refresh'>;
  /** Symmetric on purpose: a stale `false` surviving a clear would leave a plugin permanently
   *  hidden (plugins.md). */
  refreshMatchingPlugins: () => void;
  /** The record filter's single writer — the context key, the code lens, and the view's
   *  description and message. */
  showRecordFilter: (filter: RecordFilter | null) => void;
  reporter: Reporter;
}

/** Where the record filter shows. Read at each write, because the Plugins view is built after
 *  the writer is. */
export interface RecordFilterViews {
  pluginsNameFilter?: { setBaseDescription(text: string | undefined): void };
  pluginsTree?: { setRecordFilterSource(source: string | undefined): void };
}

/** The record filter's single writer. Each surface names the filter by its source, never by its
 *  SQL (plugins.md, Order and view state, story 3). */
export function makeShowRecordFilter(
  lens: { setActiveSql(sql: string | null): void }, views: RecordFilterViews,
): (filter: RecordFilter | null) => void {
  return (filter) => {
    void vscode.commands.executeCommand('setContext', 'modbench.record.filterActive', filter !== null);
    lens.setActiveSql(filter?.sql ?? null);
    views.pluginsNameFilter?.setBaseDescription(filter === null ? undefined : `records: ${filter.source}`);
    views.pluginsTree?.setRecordFilterSource(filter?.source);
  };
}

const NEW_FILTER_LABEL = '$(add) New filter…';

// The record filter scopes which records a plugin row's children show — a distinct concern from
// the record-panel and reveal commands, so it is its own registration.
export function registerFilterCommands(deps: FilterCommandDeps): vscode.Disposable[] {
  const { scriptsPath, client, treeProvider, refreshMatchingPlugins, showRecordFilter, reporter } = deps;

  const show = (filter: RecordFilter | null): void => {
    showRecordFilter(filter);
    treeProvider.refresh();
    refreshMatchingPlugins();
  };

  const apply = async (filter: RecordFilter): Promise<void> => {
    const error = await client.setFilter(filter);
    if (error !== null) {
      reporter.report('error', `Filter failed — ${error}`);
      return;
    }
    show(filter);
  };

  // catalog `filter`, Option "query source": a document the caller names, or the input box.
  const fromDocument = async (uri: vscode.Uri): Promise<void> => {
    const document = await vscode.workspace.openTextDocument(uri);
    await apply({ sql: document.getText(), source: path.basename(document.fileName) });
  };

  const fromPick = async (): Promise<void> => {
    const files = fs.existsSync(scriptsPath)
      ? fs.readdirSync(scriptsPath).filter(f => f.endsWith('.sql'))
      : [];
    const items: vscode.QuickPickItem[] = [
      ...files.map(f => ({ label: f, description: scriptsPath })),
      { label: NEW_FILTER_LABEL },
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select .sql filter file' });
    if (!picked) return;
    if (picked.label === NEW_FILTER_LABEL) {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'sql' }));
      return;
    }
    await apply({ sql: fs.readFileSync(path.join(scriptsPath, picked.label), 'utf8'), source: picked.label });
  };

  return [
    vscode.commands.registerCommand('modbench.record.filter', (source?: vscode.Uri) =>
      source === undefined ? fromPick() : fromDocument(source)),
    vscode.commands.registerCommand('modbench.record.clearFilter', async () => {
      const error = await client.clearFilter();
      if (error !== null) {
        reporter.report('error', `Could not clear the record filter — ${error}`);
        return;
      }
      show(null);
    }),
  ];
}
