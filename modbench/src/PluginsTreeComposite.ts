import * as vscode from 'vscode';

/** ADR-0035: one Plugins tree. Mod Management owns the rows, the record repository owns their
 *  children. At the composition root because it spans both bounded contexts, importing from
 *  neither — its knowledge of both domains is `pluginFileOf`, a plugin filename. */
export interface PluginsTreeCompositeDeps<TRow, TChild> {
  /** Mod Management's load-order rows. Satisfied structurally by `PluginListProvider`. */
  rows: {
    getChildren(): Promise<TRow[]> | TRow[];
    getTreeItem(row: TRow): vscode.TreeItem;
    onDidChangeTreeData: vscode.Event<TRow | undefined>;
  };
  /** Editing's record browser. Satisfied structurally by `PluginTreeProvider`. */
  children: {
    getPluginChildren(pluginFile: string): Promise<TChild[]>;
    getChildren(child: TChild): Promise<TChild[]> | TChild[];
    getTreeItem(child: TChild): vscode.TreeItem;
    onDidChangeTreeData: vscode.Event<TChild | undefined | null>;
  };
  /** The filename a row stands for, or undefined for a row that stands for no plugin file at all
   *  (an error or empty-state row). The composite's only knowledge of either side's node shapes. */
  pluginFileOf(row: TRow): string | undefined;
  /** ADR-0037: the master names this row's own order-aware badge flagged. Optional, so a row with
   *  a backend master issue and no wired accessor gets the backend's own wording, unreconciled. */
  orderIssueMastersOf?(row: TRow): string[] | undefined;
  /** ADR-0035 §Filters: whether this plugin owns a record the active record filter matches. Only
   *  ever `false` while a filter is active, so `getChildren()` reads it alone to omit the row — a
   *  visible-but-inert row is still noise. */
  hasMatchingRecords?(pluginFile: string): boolean | undefined;
}

// Structurally matches ApiClient's `MasterIssue`; the composite imports from neither context.
type MasterIssue = { masterName: string; kind: 'DirectlyMissing' | 'Unloadable' };

export class PluginsTreeComposite<TRow, TChild> implements vscode.TreeDataProvider<TRow | TChild> {
  private readonly emitter = new vscode.EventEmitter<TRow | TChild | undefined | null>();
  readonly onDidChangeTreeData = this.emitter.event;

  // VS Code only passes back an element getChildren returned, so having handed out a row is the
  // one discriminator that needs no knowledge of either side's node shapes.
  private readonly rowsSeen = new WeakSet<object>();

  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly deps: PluginsTreeCompositeDeps<TRow, TChild>) {
    // Both sides' change events are this tree's change events. Forwarded with their element
    // intact so a targeted refresh (a "Load more…" landing under one record type) stays targeted.
    this.subscriptions.push(
      deps.rows.onDidChangeTreeData((row) => this.emitter.fire(row)),
      deps.children.onDidChangeTreeData((child) => this.emitter.fire(child)),
    );
  }

  async getChildren(element?: TRow | TChild): Promise<(TRow | TChild)[]> {
    if (element === undefined) {
      const rows = await this.deps.rows.getChildren();
      // ADR-0035 §Filters: a row whose plugin the filter matches nothing of is omitted here, not
      // merely left unexpandable. A hidden row is never asked about by getTreeItem, so leaving it
      // out of rowsSeen is not a separate decision.
      const visible = rows.filter((row) => !this.isHiddenByFilter(row));
      for (const row of visible) this.rowsSeen.add(row as object);
      return visible;
    }
    if (!this.isRow(element)) return this.deps.children.getChildren(element as TChild);
    const file = this.expandableFile(element as TRow);
    if (file === undefined) return [];
    return this.deps.children.getPluginChildren(file);
  }

  getTreeItem(element: TRow | TChild): vscode.TreeItem {
    if (!this.isRow(element)) return this.deps.children.getTreeItem(element as TChild);
    const item = this.deps.rows.getTreeItem(element as TRow);
    // The chevron *is* the "editing is available now" signal (ADR-0035), decided on every render
    // rather than baked into the row: the row provider neither knows nor should know that Editing
    // exists.
    item.collapsibleState = this.expandableFile(element as TRow) === undefined
      ? vscode.TreeItemCollapsibleState.None
      : vscode.TreeItemCollapsibleState.Collapsed;
    // Decorations are decided here for the same reason the chevron is: one place allowed to know
    // what the row provider built and what the load order says. Tooltip, icon and description
    // only — never the leading slot or contextValue.
    const base = this.captureOriginalDecoration(element as object, item);
    item.tooltip = base.tooltip;
    item.description = base.description;
    item.iconPath = base.iconPath;

    const rawFile = this.deps.pluginFileOf(element as TRow);
    const file = rawFile?.toLowerCase();
    this.applyReadOnlyNote(item, file);
    this.applyBackendDecoration(item, element as TRow, file);

    return item;
  }

  // Both row providers return the row *as* its own TreeItem, so decorating in place would
  // accumulate permanently, with no way back once the condition clears.
  private captureOriginalDecoration(key: object, item: vscode.TreeItem): {
    tooltip: string | vscode.MarkdownString | undefined;
    description: vscode.TreeItem['description'];
    iconPath: vscode.TreeItem['iconPath'];
  } {
    if (!this.originalDecoration.has(key)) {
      this.originalDecoration.set(key, {
        tooltip: item.tooltip,
        description: item.description,
        iconPath: item.iconPath,
      });
    }
    return this.originalDecoration.get(key)!;
  }

  // ADR-0035: appended, never replacing, so a row's own badge survives.
  private applyReadOnlyNote(item: vscode.TreeItem, file: string | undefined): void {
    const readOnly = file !== undefined && (this.readOnlyFiles?.has(file) ?? false);
    if (!readOnly) return;
    const note = `This plugin is read-only — its records can't be edited.`;
    // A MarkdownString base would be replaced here, not appended to — no row provider produces
    // one today, so this is a documented assumption, not a bug to handle.
    item.tooltip = typeof item.tooltip === 'string' ? `${item.tooltip}\n${note}` : note;
  }

  // Backend decorations take authority only when the backend has something to say; the map
  // lookups guard a plugin the last load order never mentioned, not the wire.
  private applyBackendDecoration(item: vscode.TreeItem, row: TRow, file: string | undefined): void {
    if (file === undefined) return;
    const failureReason = this.loadFailures?.get(file);
    if (failureReason !== undefined) {
      this.applyLoadFailureDecoration(item, failureReason);
      return;
    }
    const issues = this.masterIssues?.get(file) ?? [];
    if (issues.length > 0) {
      this.applyMasterIssueDecoration(item, row, issues);
      return;
    }
    if (this.parseFailures?.has(file) ?? false) {
      this.applyParseFailureDecoration(item);
      return;
    }
    // Warning tier, below the three error decorations above — a Malformed plugin still loads and
    // plays; the badge says "look", not "broken".
    const texts = this.diagnoses?.get(file) ?? [];
    if (texts.length > 0) this.applyDiagnosisDecoration(item, texts);
  }

  // A plugin that failed to open or parse never has a MasterMetadata to derive an issue list from,
  // so this and the master-issue decoration are mutually exclusive per plugin.
  private applyLoadFailureDecoration(item: vscode.TreeItem, failureReason: string): void {
    item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'));
    item.description = '✗ Failed to load';
    const note = `Failed to load: ${failureReason}`;
    item.tooltip = typeof item.tooltip === 'string' ? `${item.tooltip}\n${note}` : note;
  }

  // The same prefix the record and record-type nodes carry (PluginTreeProvider): the backend
  // answers "holds an unreadable record" per plugin, so nothing here walks children to find out.
  private applyParseFailureDecoration(item: vscode.TreeItem): void {
    item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'));
    item.description = '✗ Unreadable records';
    const note = 'This plugin holds a record that could not be read.';
    item.tooltip = typeof item.tooltip === 'string' ? `${item.tooltip}\n${note}` : note;
  }

  // Text lines are `PluginDiagnosisReport.text` verbatim — the wording the Track refusal and the
  // Problems panel also carry, one vocabulary.
  private applyDiagnosisDecoration(item: vscode.TreeItem, texts: string[]): void {
    item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
    item.description = texts.length === 1 ? '⚠ Malformed plugin' : `⚠ ${texts.length} malformed-plugin diagnoses`;
    const note = texts.join('\n');
    item.tooltip = typeof item.tooltip === 'string' ? `${item.tooltip}\n${note}` : note;
  }

  // One decoration, not two that can disagree: a master the backend also flags is reported once,
  // in its richer load-order-aware wording; an order-only one is preserved, worded distinctly.
  private applyMasterIssueDecoration(item: vscode.TreeItem, row: TRow, issues: MasterIssue[]): void {
    const backendCovered = new Set(issues.map((i) => i.masterName.toLowerCase()));
    const orderOnly = (this.deps.orderIssueMastersOf?.(row) ?? []).filter((m) => !backendCovered.has(m.toLowerCase()));
    const lines = [
      ...issues.map((i) => i.kind === 'DirectlyMissing' ? `Missing master: ${i.masterName}` : `Master ${i.masterName} cannot be loaded`),
      ...orderOnly.map((m) => `Master ${m} is not loaded before this plugin`),
    ];
    item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'));
    item.description = lines.length === 1 ? '✗ Master issue' : `✗ ${lines.length} master issues`;
    const note = lines.join('\n');
    item.tooltip = typeof item.tooltip === 'string' ? `${item.tooltip}\n${note}` : note;
  }

  private readonly originalDecoration = new WeakMap<object, {
    tooltip: string | vscode.MarkdownString | undefined;
    description: vscode.TreeItem['description'];
    iconPath: vscode.TreeItem['iconPath'];
  }>();

  private isRow(element: TRow | TChild): boolean {
    return this.rowsSeen.has(element as object);
  }

  /** ADR-0044. Mod Management works with no backend running — the ordinary case, not a failure —
   *  so the composition root checks this rather than let a doomed PUT surface as an error toast. */
  hasLoadOrder(): boolean {
    return this.heldFiles !== undefined;
  }

  // Nothing held answers undefined because a row that expands to an empty list reads as "this
  // plugin has no records" — ADR-0026's silent-wrong-state tier.
  private expandableFile(row: TRow): string | undefined {
    if (this.heldFiles === undefined) return undefined;
    const file = this.deps.pluginFileOf(row);
    return file === undefined || !this.heldFiles.has(file.toLowerCase()) ? undefined : file;
  }

  // `hasMatchingRecords` only ever answers `false` while a filter is active, so no separate
  // "is a filter active" signal has to be threaded in here.
  private isHiddenByFilter(row: TRow): boolean {
    const file = this.deps.pluginFileOf(row);
    return file !== undefined && this.deps.hasMatchingRecords?.(file) === false;
  }

  private heldFiles?: Set<string>;
  private readOnlyFiles?: Set<string>;
  private masterIssues?: Map<string, MasterIssue[]>;
  private loadFailures?: Map<string, string>;
  private parseFailures?: Set<string>;
  private diagnoses?: Map<string, string[]>;

  /** One setter, not four: these facts are a single hand-off from the same reconcile and never
   *  change independently. Chevrons appearing and disappearing is the entire "editing is available
   *  now" signal (ADR-0035) — no banner, no mode. */
  setLoadOrder(
    pluginFiles: Set<string> | undefined,
    readOnlyFiles: Set<string> = new Set(),
    masterIssues: Map<string, MasterIssue[]> = new Map(),
    loadFailures: Map<string, string> = new Map(),
    parseFailures: Set<string> = new Set(),
  ): void {
    this.heldFiles = pluginFiles && new Set([...pluginFiles].map((f) => f.toLowerCase()));
    this.readOnlyFiles = pluginFiles && new Set([...readOnlyFiles].map((f) => f.toLowerCase()));
    this.masterIssues = pluginFiles && new Map([...masterIssues].map(([name, issues]) => [name.toLowerCase(), issues]));
    this.loadFailures = pluginFiles && new Map([...loadFailures].map(([name, reason]) => [name.toLowerCase(), reason]));
    this.parseFailures = pluginFiles && new Set([...parseFailures].map((f) => f.toLowerCase()));
    // A reconcile invalidates the last scan's diagnoses — they describe binaries the load order
    // may not hold — so they clear here and return via setDiagnoses when the new scan lands.
    this.diagnoses = undefined;
    this.emitter.fire(undefined);
  }

  /** A separate setter from `setLoadOrder` because it arrives from a separate, later fetch; it
   *  cannot drift past the load order it describes, because every `setLoadOrder` clears it. */
  setDiagnoses(diagnoses: Map<string, string[]>): void {
    this.diagnoses = new Map([...diagnoses].map(([name, texts]) => [name.toLowerCase(), texts]));
    this.emitter.fire(undefined);
  }

  /** Deliberately not the row provider's `invalidate()`, which re-reads plugins.txt from disk:
   *  that hands out fresh row objects, discarding the per-row decoration state keyed to the old
   *  ones and losing the tree's selection with it. */
  refreshDecorations(): void {
    this.emitter.fire(undefined);
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    this.emitter.dispose();
  }
}
