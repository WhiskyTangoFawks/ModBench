// Row rendering only: which column the rows are ordered by and which of them show live in
// downloadRows.ts, the same split ModListProvider makes for modlist.txt.

import * as vscode from 'vscode';
import {
  downloadedFileContextValue, filterExcludedRows, sortDownloadedFileRows, type DownloadedFileSortColumn,
} from './downloadRows';
import {
  instanceMessages, type DownloadFile, type DownloadRow, type DownloadStatus, type InstanceValue, type InstanceView,
} from '../instanceLoader/instance';
import { firstReadOf, type FirstRead } from '../drivingLib/instanceFirstRead';
import { ErrorNode } from '../drivingLib/errorNode';
import { messageLine } from '../drivingLib/messageLine';
import type { DownloadedFileArgument } from '../drivingLib/argument';

// Mirrors the reference tool's own colour-coded Status cell. The icon is always set explicitly so
// the file-icon theme never takes over; a colour is affordable because every row is an archive.
function downloadedFileStatusIcon(status: DownloadStatus): vscode.ThemeIcon {
  switch (status) {
    case 'Downloaded':
      return new vscode.ThemeIcon('archive', new vscode.ThemeColor('charts.green'));
    case 'Installed':
      return new vscode.ThemeIcon('check');
    case 'Uninstalled':
      return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.yellow'));
  }
}

// `v%1` is the reference tool's own version display convention. The icon always carries status, so
// the description repeats it only for a state other than the Downloaded default.
function downloadedFileDescription(row: DownloadRow): string {
  const version = row.version ? `v${row.version}` : undefined;
  const status = row.status === 'Downloaded' ? undefined : row.status;
  return [version, status].filter((s): s is string => !!s).join(' ');
}

// A manually-dropped archive with no sidecar still gets a valid, minimal tooltip.
function downloadedFileTooltip(row: DownloadRow): vscode.MarkdownString {
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
 *  label, and a metadata name change would then silently drop the user's tree selection. */
export class DownloadedFileNode extends vscode.TreeItem {
  readonly kind = 'downloadedFile' as const;
  /** The Argument view on Nexus reads, which the Mods row supplies under the same name. */
  readonly nexusModId: string | undefined;
  readonly nexusGame: string | undefined;
  readonly argument: DownloadedFileArgument;
  constructor(row: DownloadFile) {
    super(row.displayName, vscode.TreeItemCollapsibleState.None);
    this.argument = { kind: 'downloadedFile', row };
    this.nexusModId = row.modID;
    this.nexusGame = row.gameName;
    this.id = row.name;
    this.iconPath = downloadedFileStatusIcon(row.status);
    this.description = downloadedFileDescription(row);
    this.tooltip = downloadedFileTooltip(row);
    this.contextValue = downloadedFileContextValue(row);
    // Decoration hook — the dimming FileDecorationProvider keys off this URI.
    this.resourceUri = vscode.Uri.file(row.path);
  }
}

export type DownloadsTreeNode = DownloadedFileNode | ErrorNode;

interface DownloadsProviderOptions {
  /** downloads/ rows, metadata folded in. */
  instance: InstanceView;
}

/** Flat: downloads have no grouping or reorder concept, so every row is a leaf. One row per
 *  archive, from the Instance value alone (ADR-0015). */
export class DownloadsProvider implements vscode.TreeDataProvider<DownloadsTreeNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<DownloadsTreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly instance: InstanceView;
  private instanceValue: InstanceValue;
  private readonly instanceSubscription: vscode.Disposable;
  private readonly readFailureSubscription: vscode.Disposable;
  private readonly firstRead: FirstRead;

  private cache?: DownloadedFileNode[];

  // Transient view state — never persisted, matching the Mods tree's Sort Direction
  // toggle: a fresh activation always starts back at the spec's defaults (excluded rows hidden,
  // Filetime descending).
  private showExcluded = false;
  private sortColumn: DownloadedFileSortColumn = 'mtimeMs';
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
    this.readFailureSubscription = options.instance.onReadFailure(() => this._onDidChangeTreeData.fire(undefined));
  }

  viewMessage(): string | undefined {
    return messageLine(...instanceMessages(this.instance));
  }

  dispose(): void {
    this.instanceSubscription.dispose();
    this.readFailureSubscription.dispose();
    this.firstRead.dispose();
  }

  private invalidate(): void {
    this.cache = undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Additive, not an exclusive filter, matching the reference tool's own Show Hidden. The command
   *  handler, not this, owns the `modbench.downloadedFile.excludedShown` context key. */
  setShowExcluded(show: boolean): void {
    this.showExcluded = show;
    this.invalidate();
  }

  setSort(column: DownloadedFileSortColumn, descending: boolean): void {
    this.sortColumn = column;
    this.sortDescending = descending;
    this.invalidate();
  }

  /** What the sort pick pre-selects (downloads.md, Order and view state, story 2: "The pick
   *  marks the current sort"). */
  currentSort(): { column: DownloadedFileSortColumn; descending: boolean } {
    return { column: this.sortColumn, descending: this.sortDescending };
  }

  /** The all-excluded empty state (downloads.md, States, story 2), distinct from the name
   *  filter's own no-match state. */
  allExcluded(): boolean {
    if (this.showExcluded || this.instanceValue.downloads.kind !== 'listed') return false;
    const { rows } = this.instanceValue.downloads;
    return rows.length > 0 && rows.every((row) => row.excluded);
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
    const excluded = (this.cache ?? []).filter((n) => n.argument.row.excluded);
    return new Set(excluded.map((n) => n.argument.row.name));
  }

  getTreeItem(element: DownloadsTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: DownloadsTreeNode): Promise<DownloadsTreeNode[]> {
    if (element) return []; // flat list — no row has children
    await this.firstRead.settled; // never claim "no downloads" before the Instance has actually read one
    if (this.firstRead.failure !== undefined) return [new ErrorNode(this.firstRead.failure)];
    // A folder Modbench cannot resolve is not the folder the mod manager names — no rows, so no
    // command has anything to act on (common.md, States, story 2; scoped to this view alone).
    if (this.instanceValue.downloads.kind === 'unresolved') return [new ErrorNode(this.instanceValue.downloads.reason)];
    this.cache ??= this.build(this.instanceValue.downloads.rows);
    if (!this.filterLower) return this.cache;
    return this.cache.filter((n) => n.argument.row.displayName.toLowerCase().includes(this.filterLower));
  }

  private build(downloads: readonly DownloadFile[]): DownloadedFileNode[] {
    const rows = sortDownloadedFileRows(filterExcludedRows(downloads, this.showExcluded), this.sortColumn, this.sortDescending);
    return rows.map((row) => new DownloadedFileNode(row));
  }
}
