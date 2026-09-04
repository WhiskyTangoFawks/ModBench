// Row rendering only: sorting and filtering live in mo2/downloads.ts, the same split
// ModListProvider makes for modlist.txt.

import * as vscode from 'vscode';
import { join } from 'node:path';
import {
  buildDownloadRows,
  downloadContextValue,
  filterHiddenRows,
  sortDownloadRows,
  type DownloadRow,
  type DownloadSortColumn,
  type DownloadStatus,
} from './mo2/downloads';
import { scanDownloads } from './DownloadsPanel';
import { ErrorNode } from './ErrorNode';

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
  constructor(public readonly row: DownloadRow, instanceRoot: string) {
    super(row.displayName, vscode.TreeItemCollapsibleState.None);
    this.id = row.name;
    this.iconPath = downloadStatusIcon(row.status);
    this.description = downloadDescription(row);
    this.tooltip = downloadTooltip(row);
    this.contextValue = downloadContextValue(row);
    // Decoration hook — the dimming FileDecorationProvider keys off this URI.
    this.resourceUri = vscode.Uri.file(join(instanceRoot, 'downloads', row.name));
  }
}

export type DownloadsNode = DownloadNode | ErrorNode;

/** Flat: downloads have no grouping or reorder concept, so every row is a leaf. */
export class DownloadsProvider implements vscode.TreeDataProvider<DownloadsNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<DownloadsNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cache?: DownloadsNode[];

  // Transient view state — never persisted, matching the Mods tree's Sort Direction
  // toggle: a fresh activation always starts back at the spec's defaults (hidden excluded,
  // Filetime descending).
  private showHidden = false;
  private sortColumn: DownloadSortColumn = 'mtimeMs';
  private sortDescending = true;
  private filterLower = '';

  constructor(
    private readonly instanceRoot: string,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  invalidate(): void {
    this.cache = undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Additive, not an exclusive filter, matching MO2's own Show-hidden. The command handler,
   *  not this, owns the `modbench.downloads.showHidden` context key. */
  setShowHidden(show: boolean): void {
    this.showHidden = show;
    this.invalidate();
  }

  setSort(column: DownloadSortColumn, descending: boolean): void {
    this.sortColumn = column;
    this.sortDescending = descending;
    this.invalidate();
  }

  /** Render-only: a filter keystroke narrows already-built rows and never re-scans
   *  downloads/. An empty string clears the filter. */
  setFilter(text: string): void {
    this.filterLower = text.toLowerCase();
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Empty before the first render, and whenever Show hidden is off, because hidden rows are
   *  then already absent from the cache. */
  hiddenNames(): ReadonlySet<string> {
    const hidden = (this.cache ?? []).filter(
      (n): n is DownloadNode => n instanceof DownloadNode && n.row.hidden,
    );
    return new Set(hidden.map((n) => n.row.name));
  }

  getTreeItem(element: DownloadsNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: DownloadsNode): Promise<DownloadsNode[]> {
    if (element) return []; // flat list — no row has children
    this.cache ??= await this.load();
    if (!this.filterLower) return this.cache;
    // An ErrorNode survives every filter — hiding the reason the list is wrong behind a
    // name match is exactly the silently-wrong state ADR-0026 forbids.
    return this.cache.filter((n) =>
      !(n instanceof DownloadNode) || n.row.name.toLowerCase().includes(this.filterLower));
  }

  // The downloads folder can appear and disappear live, so `modbench.downloadsFolderExists` is
  // republished on every re-scan rather than checked once at activation. On failure the key is
  // left untouched: existence is then genuinely unknown, not false.
  private async load(): Promise<DownloadsNode[]> {
    let entries;
    try {
      entries = await scanDownloads(this.instanceRoot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[DownloadsProvider] scanning downloads/ failed: ${message}`);
      return [new ErrorNode(message)];
    }
    void vscode.commands.executeCommand('setContext', 'modbench.downloadsFolderExists', entries !== undefined);
    if (!entries) return [];
    // Hidden-filtering applies first, then sort — the acceptance criterion the two compose by.
    const filtered = filterHiddenRows(buildDownloadRows(entries), this.showHidden);
    const rows = sortDownloadRows(filtered, this.sortColumn, this.sortDescending);
    return rows.map((row) => new DownloadNode(row, this.instanceRoot));
  }
}
