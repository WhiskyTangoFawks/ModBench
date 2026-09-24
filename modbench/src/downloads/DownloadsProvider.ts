// Row rendering only: which column the rows are ordered by and which of them show live in
// downloadRows.ts, the same split ModListProvider makes for modlist.txt.

import * as vscode from 'vscode';
import {
  downloadContextValue, filterArchiveRows, filterHiddenRows, sortDownloadRows, type DownloadSortColumn,
} from './downloadRows';
import type {
  DownloadFile, DownloadRow, DownloadStatus, InstanceValue, InstanceView,
} from '../instanceLoader/instance';
import { firstReadOf, type FirstRead } from './instanceFirstRead';
import { ErrorNode } from './errorNode';

// Mirrors MO2's own colour-coded Status cell. The icon is always set explicitly so the
// file-icon theme never takes over; a colour is affordable because every row is an archive.
function downloadStatusIcon(status: DownloadStatus): vscode.ThemeIcon {
  switch (status) {
    case 'Downloaded':
      return new vscode.ThemeIcon('archive', new vscode.ThemeColor('charts.green'));
    case 'Installed':
      return new vscode.ThemeIcon('check');
    case 'Uninstalled':
      return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.yellow'));
  }
}

// `v%1` is MO2's own version display convention. The icon always carries status, so the
// description repeats it only for a state other than the Downloaded default.
function downloadDescription(row: DownloadRow): string {
  const version = row.version ? `v${row.version}` : undefined;
  const status = row.status === 'Downloaded' ? undefined : row.status;
  return [version, status].filter((s): s is string => !!s).join(' ');
}

// A manually-dropped archive with no sidecar still gets a valid, minimal tooltip.
function downloadTooltip(row: DownloadRow): vscode.MarkdownString {
  const lines = [
    `**${row.name}**`,
    row.modName && `Mod: ${row.modName}`,
    row.version && `Version: v${row.version}`,
    row.modID && `Nexus ID: ${row.modID}`,
    `Size: ${row.size}`,
    `Filetime: ${new Date(row.mtimeMs).toLocaleString()}`,
    row.gameName && `Game: ${row.gameName}`,
    row.author && `Author: ${row.author}`,
  ].filter((l): l is string => !!l);
  return new vscode.MarkdownString(lines.join('  \n'));
}

/** `id` is pinned to the raw filename because TreeItem otherwise auto-derives it from the
 *  label, and a `.meta` name change would then silently drop the user's tree selection. */
export class DownloadNode extends vscode.TreeItem {
  readonly kind = 'download' as const;
  /** The Argument view on Nexus reads, which the Mods row supplies under the same name. */
  readonly nexusModId: string | undefined;
  constructor(public readonly row: DownloadFile) {
    super(row.displayName, vscode.TreeItemCollapsibleState.None);
    this.nexusModId = row.modID;
    this.id = row.name;
    this.iconPath = downloadStatusIcon(row.status);
    this.description = downloadDescription(row);
    this.tooltip = downloadTooltip(row);
    this.contextValue = downloadContextValue(row);
    // Decoration hook — the dimming FileDecorationProvider keys off this URI.
    this.resourceUri = vscode.Uri.file(row.path);
  }
}

export type DownloadsTreeNode = DownloadNode | ErrorNode;

export interface DownloadsProviderOptions {
  /** downloads/ rows, `.meta` sidecars folded in — the row provider's only row input
   *  (ADR-0015). */
  instance: InstanceView;
}

/** Flat: downloads have no grouping or reorder concept, so every row is a leaf. One row per
 *  archive, read entirely from the Instance value (ADR-0015); this provider owns no cache or
 *  watcher over downloads/ itself. */
export class DownloadsProvider implements vscode.TreeDataProvider<DownloadsTreeNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<DownloadsTreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly instance: InstanceView;
  private instanceValue: InstanceValue;
  private readonly instanceSubscription: vscode.Disposable;
  private readonly firstRead: FirstRead;

  private cache?: DownloadNode[];

  // Transient view state — never persisted, matching the Mods tree's Sort Direction
  // toggle: a fresh activation always starts back at the spec's defaults (hidden excluded,
  // Filetime descending).
  private showHidden = false;
  private sortColumn: DownloadSortColumn = 'mtimeMs';
  private sortDescending = true;
  private filterLower = '';

  constructor(options: DownloadsProviderOptions) {
    this.instance = options.instance;
    this.instanceValue = options.instance.value;
    this.firstRead = firstReadOf(options.instance);
    this.instanceSubscription = options.instance.subscribe((value) => {
      this.instanceValue = value;
      this.invalidate();
    });
  }

  dispose(): void {
    this.instanceSubscription.dispose();
    this.firstRead.dispose();
  }

  // Re-pulls `instance.value` rather than trusting the copy the last subscriber callback left:
  // a caller forcing a resync (Refresh All) gets whatever the Instance is currently holding, not
  // a snapshot that predates it.
  invalidate(): void {
    this.instanceValue = this.instance.value;
    this.cache = undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Additive, not an exclusive filter, matching MO2's own Show-hidden. The command handler,
   *  not this, owns the `modbench.downloadedFile.excludedShown` context key. */
  setShowHidden(show: boolean): void {
    this.showHidden = show;
    this.invalidate();
  }

  setSort(column: DownloadSortColumn, descending: boolean): void {
    this.sortColumn = column;
    this.sortDescending = descending;
    this.invalidate();
  }

  /** What the sort pick pre-selects (downloads.md, Order and view state, story 2: "The pick
   *  marks the current sort"). */
  currentSort(): { column: DownloadSortColumn; descending: boolean } {
    return { column: this.sortColumn, descending: this.sortDescending };
  }

  /** The all-excluded empty state (downloads.md, States, story 2), distinct from the name
   *  filter's own no-match state. */
  allExcluded(): boolean {
    if (this.showHidden) return false;
    const archives = filterArchiveRows(this.instanceValue.downloads);
    return archives.length > 0 && archives.every((row) => row.hidden);
  }

  /** Render-only: a filter keystroke narrows already-built rows and never re-pulls the Instance
   *  value. An empty string clears the filter. */
  setFilter(text: string): void {
    this.filterLower = text.toLowerCase();
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Empty before the first render, and whenever Show excluded is off, because excluded rows
   *  are then already absent from the cache. */
  excludedNames(): ReadonlySet<string> {
    const excluded = (this.cache ?? []).filter((n) => n.row.hidden);
    return new Set(excluded.map((n) => n.row.name));
  }

  getTreeItem(element: DownloadsTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: DownloadsTreeNode): Promise<DownloadsTreeNode[]> {
    if (element) return []; // flat list — no row has children
    await this.firstRead.settled; // never claim "no downloads" before the Instance has actually read one
    if (this.firstRead.failure !== undefined) return [new ErrorNode(this.firstRead.failure)];
    this.cache ??= this.build();
    if (!this.filterLower) return this.cache;
    return this.cache.filter((n) => n.row.displayName.toLowerCase().includes(this.filterLower));
  }

  private build(): DownloadNode[] {
    // Archive-filtering applies first — a non-archive is never a row, toggle or not — then
    // hidden-filtering, then sort — the acceptance criterion the three compose by.
    const archives = filterArchiveRows(this.instanceValue.downloads);
    const filtered = filterHiddenRows(archives, this.showHidden);
    const rows = sortDownloadRows(filtered, this.sortColumn, this.sortDescending);
    return rows.map((row) => new DownloadNode(row));
  }
}
