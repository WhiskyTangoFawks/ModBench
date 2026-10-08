import * as vscode from 'vscode';
import type { MEditClient, RecordFilter } from '../client';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import type { RecordBrowser } from './RecordBrowser';

export interface FilterCommandDeps {
  client: Pick<MEditClient, 'setFilter' | 'clearFilter' | 'getActiveFilter' | 'onNotification'>;
  treeProvider: Pick<RecordBrowser, 'refresh'>;
  /** Symmetric on purpose: a stale `false` surviving a clear would leave a plugin permanently
   *  hidden (plugins.md). */
  refreshMatchingPlugins: () => void;
  showRecordFilter: ShowRecordFilter;
  reporter: Reporter;
}

/** Where the record filter shows. */
export interface RecordFilterViews {
  pluginsNameFilter: { setBaseDescription(text: string | undefined): void };
  pluginsTree: { setRecordFilterSource(source: string | undefined): void };
}

export type ShowRecordFilter = ((filter: RecordFilter | null) => void) & { shownSource(): string | undefined };

/** The record filter's single writer. Each surface names the filter by its source, never by its
 *  SQL (plugins.md, Order and view state, story 3). */
export function makeShowRecordFilter(
  lens: { setActiveSql(sql: string | null): void }, views: RecordFilterViews,
): ShowRecordFilter {
  let shown: string | undefined;
  const show = (filter: RecordFilter | null): void => {
    shown = filter?.source;
    void vscode.commands.executeCommand('setContext', 'modbench.record.filterActive', filter !== null);
    lens.setActiveSql(filter?.sql ?? null);
    views.pluginsNameFilter.setBaseDescription(filter === null ? undefined : `records: ${filter.source}`);
    views.pluginsTree.setRecordFilterSource(filter?.source);
  };
  return Object.assign(show, { shownSource: () => shown });
}

const NEW_FILTER_LABEL = '$(add) New filter…';

// The record filter scopes which records a plugin row's children show — a distinct concern from
// the record-panel and reveal commands, so it is its own registration.
export function registerFilterCommands(deps: FilterCommandDeps): vscode.Disposable[] {
  const { client, treeProvider, refreshMatchingPlugins, showRecordFilter, reporter } = deps;

  const show = (filter: RecordFilter | null): void => {
    showRecordFilter(filter);
    treeProvider.refresh();
    refreshMatchingPlugins();
  };

  let applying: string | undefined;
  const clearedWhileApplying = new Set<string>();

  const apply = async (filter: RecordFilter): Promise<void> => {
    applying = filter.source;
    clearedWhileApplying.delete(filter.source);
    const error = await client.setFilter(filter);
    applying = undefined;
    if (error !== null) {
      reporter.report('error', `Filter failed — ${error}`);
      return;
    }
    if (!clearedWhileApplying.has(filter.source)) show(filter);
  };

  // The clearing can outrun the reply to the set that it clears, so what mEdit holds decides what shows.
  const onCleared = async ({ source, reason }: { source: string; reason: string }): Promise<void> => {
    const shownBefore = showRecordFilter.shownSource();
    const wasApplying = applying === source;
    if (wasApplying) clearedWhileApplying.add(source);
    const message = `The record filter ${source} was cleared`;
    const say = (viewChanged: boolean): void => {
      if (viewChanged || wasApplying || shownBefore === source) reporter.report('warning', message, reason);
      else reporter.shownOnSurface('warning', message, reason);
    };
    try {
      show(await client.getActiveFilter());
      say(showRecordFilter.shownSource() !== shownBefore);
    } catch (e) {
      say(false);
      reporter.report('error', 'Could not read the record filter', errorMessage(e));
    }
  };

  // catalog `filter`, Option "query source": a document the caller names, or the input box.
  const fromDocument = async (uri: vscode.Uri): Promise<void> => {
    const document = await vscode.workspace.openTextDocument(uri);
    await apply({ sql: document.getText(), source: vscode.workspace.asRelativePath(document.uri) });
  };

  const fromPick = async (): Promise<void> => {
    const files = await vscode.workspace.findFiles('**/*.sql');
    const items: (vscode.QuickPickItem & { uri?: vscode.Uri })[] = [
      ...files.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri })),
      { label: NEW_FILTER_LABEL },
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select .sql filter file' });
    if (!picked) return;
    if (picked.uri === undefined) {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'sql' }));
      return;
    }
    await fromDocument(picked.uri);
  };

  return [
    { dispose: client.onNotification('record-filter-cleared', (cleared) => { void onCleared(cleared); }) },
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
