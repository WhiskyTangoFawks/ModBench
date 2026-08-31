// Sidebar tree over the instance's downloads/ folder. Row rendering only — sorting/filtering already lives in mo2/downloads.ts (buildDownloadRows,
// filterHiddenRows); this file's job is turning a DownloadRow into a vscode.TreeItem and scanning
// downloads/ into rows, the same split ModListProvider makes for modlist.txt.

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

/** Status -> ThemeIcon id + colour, mirroring MO2's Status-cell colours
 *  (downloadlist.cpp:202): green for ready-to-install, yellow for uninstalled, no explicit
 *  colour for installed (done). Icon is always set explicitly so the file-icon theme never
 *  takes over — the analogous convention to ModListProvider's statusIconId (lines 46-56),
 *  except downloads carry a colour too since every row is an archive (no file-type signal
 *  to spend the icon on) and MO2's own Status column is itself colour-coded. */
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

/** Version (`v2.2.1`, MO2's own `v%1` display convention — downloadmanager.cpp's
 *  displayNameByInfo), plus the status word for a non-default state. Downloaded is the
 *  unmarked default (mirrors ModNode's description convention, ModListProvider.ts:112:
 *  the icon always carries status, the description repeats it only when not the default). */
function downloadDescription(row: DownloadRow): string {
  const version = row.version ? `v${row.version}` : undefined;
  const status = row.status === 'Downloaded' ? undefined : row.status;
  return [version, status].filter((s): s is string => !!s).join(' ');
}

/** Filename (always present), then every optional `.meta` tooltip field that's actually
 *  recorded — a manually-dropped archive with no sidecar still gets a valid, minimal tooltip. */
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

/** One row = one archive. `id` is pinned to the raw filename (never the label) so a later
 *  `.meta` name change can't silently drop the user's tree selection — TreeItem's id
 *  otherwise auto-derives from the label. */
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

/** Inline error surface: shown instead of an empty list when scanning downloads/ fails for a
 *  reason other than "no downloads/ folder" (that's the structural-absence empty state, not an
 *  error — see load()). Mirrors ModListProvider's ErrorNode (ADR-0026: a failure must never be
 *  indistinguishable from "nothing here"). */
export class ErrorNode extends vscode.TreeItem {
  readonly kind = 'error' as const;
  constructor(message: string) {
    super(`⚠ Failed to load: ${message}`, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'error';
    this.tooltip = message;
    this.iconPath = new vscode.ThemeIcon('error');
  }
}

export type DownloadsNode = DownloadNode | ErrorNode;

/** Sidebar Downloads tree over an MO2 instance's downloads/ folder. Flat (no grouping/
 *  reorder concept, unlike ModListProvider) — every row is a leaf. */
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

  /** Clears the cached rows and re-renders — a mutation or watcher-observed disk change
   *  invalidated what's on screen, so the next read must re-scan downloads/ (mirrors
   *  ModListProvider.invalidate(), ModListProvider.ts:200-206). */
  invalidate(): void {
    this.cache = undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Show hidden toggle: additive, not an exclusive filter — matches MO2's own
   *  Show-hidden (downloadmanager.cpp:102). Re-renders via invalidate(), same as
   *  ModListProvider.toggleViewDirection(); the command handler owns setting the
   *  `modbench.downloads.showHidden` context key. */
  setShowHidden(show: boolean): void {
    this.showHidden = show;
    this.invalidate();
  }

  /** Sort by… quick pick: re-orders the rendered rows by any of the four sortable
   *  columns, either direction. Transient like showHidden above — resets to Filetime
   *  descending on the next activation, never persisted. */
  setSort(column: DownloadSortColumn, descending: boolean): void {
    this.sortColumn = column;
    this.sortDescending = descending;
    this.invalidate();
  }

  /** Set the title-bar name filter (empty string clears it) and re-render — the same
   *  transient-InputBox widget every other list view uses.
   *  Render-only — a filter keystroke narrows already-built rows and never re-scans
   *  downloads/, matching PluginListProvider.setFilter's render-vs-invalidate split. */
  setFilter(text: string): void {
    this.filterLower = text.toLowerCase();
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Names of rows currently rendered as hidden — feeds HiddenDownloadDecorationProvider's
   *  dimming. Empty before the first render, and empty whenever Show hidden is off, since
   *  filterHiddenRows has already dropped hidden rows from the cache entirely in that case. */
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

  /** Scans downloads/, builds and hidden-filters rows, and republishes
   *  modbench.downloadsFolderExists — the folder can appear/disappear live via the watcher,
   *  so this is re-issued on every re-scan (not a one-time activation check, unlike the
   *  MO2-instance welcome's `workspaceIsMo2Instance`, extension.ts:1093/1121/1131). A scan
   *  failure other than "no folder" (scanDownloads only swallows ENOENT) surfaces as an
   *  ErrorNode instead of throwing out of getChildren — ADR-0026, mirrors ModListProvider.load().
   *  The folder-exists key is left untouched on failure: existence is genuinely unknown, not false. */
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
