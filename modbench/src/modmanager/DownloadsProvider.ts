// Row rendering only: sorting and filtering live in mo2/downloads.ts, the same split
// ModListProvider makes for modlist.txt.

import * as vscode from 'vscode';
import { join } from 'node:path';
import {
  downloadContextValue,
  filterHiddenRows,
  sortDownloadRows,
  type DownloadRow,
  type DownloadSortColumn,
  type DownloadStatus,
} from './mo2/downloads';
import type { Instance, InstanceValue } from './instance';

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

export interface DownloadsProviderOptions {
  instanceRoot: string;
  /** downloads/ rows, `.meta` sidecars folded in — the row provider's only row input
   *  (ADR-0047). */
  instance: Pick<Instance, 'value' | 'subscribe' | 'sequence'>;
}

/** Flat: downloads have no grouping or reorder concept, so every row is a leaf. One row per
 *  archive, read entirely from the Instance value (ADR-0047); this provider owns no cache or
 *  watcher over downloads/ itself. */
export class DownloadsProvider implements vscode.TreeDataProvider<DownloadNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<DownloadNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly instanceRoot: string;
  private readonly instance: Pick<Instance, 'value' | 'subscribe' | 'sequence'>;
  private instanceValue: InstanceValue;
  private readonly instanceSubscription: vscode.Disposable;
  // Resolves once the Instance lands its first recompute. `sequence === 0` means "not read
  // yet", never "genuinely empty" — lets `getChildren()` await it instead of showing no rows
  // before the Instance has read once (mirrors PluginListProvider's `firstValue`).
  private readonly firstValue: Promise<void>;
  private resolveFirstValue: (() => void) | undefined;

  private cache?: DownloadNode[];

  // Transient view state — never persisted, matching the Mods tree's Sort Direction
  // toggle: a fresh activation always starts back at the spec's defaults (hidden excluded,
  // Filetime descending).
  private showHidden = false;
  private sortColumn: DownloadSortColumn = 'mtimeMs';
  private sortDescending = true;
  private filterLower = '';

  constructor(options: DownloadsProviderOptions) {
    this.instanceRoot = options.instanceRoot;
    this.instance = options.instance;
    this.instanceValue = options.instance.value;
    this.firstValue = options.instance.sequence > 0
      ? Promise.resolve()
      : new Promise((resolve) => { this.resolveFirstValue = resolve; });
    this.instanceSubscription = options.instance.subscribe((value) => {
      this.instanceValue = value;
      this.resolveFirstValue?.();
      this.invalidate();
    });
  }

  dispose(): void {
    this.instanceSubscription.dispose();
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

  /** Render-only: a filter keystroke narrows already-built rows and never re-pulls the Instance
   *  value. An empty string clears the filter. */
  setFilter(text: string): void {
    this.filterLower = text.toLowerCase();
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Empty before the first render, and whenever Show hidden is off, because hidden rows are
   *  then already absent from the cache. */
  hiddenNames(): ReadonlySet<string> {
    const hidden = (this.cache ?? []).filter((n) => n.row.hidden);
    return new Set(hidden.map((n) => n.row.name));
  }

  getTreeItem(element: DownloadNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: DownloadNode): Promise<DownloadNode[]> {
    if (element) return []; // flat list — no row has children
    await this.firstValue; // never claim "no downloads" before the Instance has actually read one
    this.cache ??= this.build();
    if (!this.filterLower) return this.cache;
    return this.cache.filter((n) => n.row.name.toLowerCase().includes(this.filterLower));
  }

  private build(): DownloadNode[] {
    // Hidden-filtering applies first, then sort — the acceptance criterion the two compose by.
    const filtered = filterHiddenRows(this.instanceValue.downloads, this.showHidden);
    const rows = sortDownloadRows(filtered, this.sortColumn, this.sortDescending);
    return rows.map((row) => new DownloadNode(row, this.instanceRoot));
  }
}
