import * as vscode from 'vscode';

/** The one Plugins tree (#270 / [ADR-0035](../../docs/adr/0035-one-plugins-tree-editing-is-a-capability.md)):
 *  Mod Management owns the rows — identity, load order, checkbox, decorations — and the record
 *  repository owns their children. This joins the two and does nothing else.
 *
 *  It lives at the composition root, alongside `LoadoutHeaderProvider` and for the same reason: it
 *  spans both bounded contexts, so it can belong to neither folder. ADR-0027 rejected merging these
 *  views partly because it "conflates two bounded contexts"; ADR-0035 answers that structurally
 *  rather than by assertion, which is what this file has to keep true. Concretely it imports no
 *  type from either side and holds no record or mod vocabulary: rows and children are type
 *  parameters, and its entire knowledge of both domains is `pluginFileOf` — a plugin filename,
 *  which is the boundary object `CONTEXT-MAP.md` already names.
 *
 *  Depth here is locality, not leverage: ADR-0035 requires the composite to be *thin*, so what it
 *  buys is that the join exists in exactly one place, with one setter and one accessor, instead of
 *  smeared across `extension.ts` or (worse) pushed into one of the two providers. */
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
}

export class PluginsTreeComposite<TRow, TChild> implements vscode.TreeDataProvider<TRow | TChild> {
  private readonly emitter = new vscode.EventEmitter<TRow | TChild | undefined | null>();
  readonly onDidChangeTreeData = this.emitter.event;

  /** Every row this tree has handed out. Rows and children share one element type from VS Code's
   *  point of view, and VS Code only ever passes back an element it was given, so having produced
   *  a row is the one discriminator that needs no knowledge of either side's node shapes. Weak so
   *  a re-rendered row set doesn't pin the old one in memory.
   *
   *  This leans on VS Code's own `TreeDataProvider` contract — `getTreeItem` is only ever called
   *  with an element a `getChildren` returned — so the root must be rendered before any row is
   *  asked about. That holds for the view, and it is why this class's tests render first too. */
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
      for (const row of rows) this.rowsSeen.add(row as object);
      return rows;
    }
    if (!this.isRow(element)) return this.deps.children.getChildren(element as TChild);
    const file = this.expandableFile(element as TRow);
    return file === undefined ? [] : this.deps.children.getPluginChildren(file);
  }

  getTreeItem(element: TRow | TChild): vscode.TreeItem {
    if (!this.isRow(element)) return this.deps.children.getTreeItem(element as TChild);
    const item = this.deps.rows.getTreeItem(element as TRow);
    // The chevron *is* the "editing is available now" signal (ADR-0035), so it is decided here on
    // every render rather than baked into the row when it was built: the row provider neither
    // knows nor should know that a session exists. Set both ways — closing a session has to take
    // the chevrons back off rows the provider is still caching.
    item.collapsibleState = this.expandableFile(element as TRow) === undefined
      ? vscode.TreeItemCollapsibleState.None
      : vscode.TreeItemCollapsibleState.Collapsed;
    return item;
  }

  private isRow(element: TRow | TChild): boolean {
    return this.rowsSeen.has(element as object);
  }

  /** The plugin file this row can browse, or undefined when it can't be expanded — no session, no
   *  plugin file, or a file the session doesn't hold. That last case is the honest one: a row
   *  whose plugin never made it into the session would otherwise expand to an empty list, which
   *  reads as "this plugin has no records" (ADR-0026's silent-wrong-state tier). */
  private expandableFile(row: TRow): string | undefined {
    if (this.sessionFiles === undefined) return undefined;
    const file = this.deps.pluginFileOf(row);
    return file !== undefined && this.sessionFiles.has(file.toLowerCase()) ? file : undefined;
  }

  private sessionFiles?: Set<string>;

  /** The plugin files the editing session holds, or undefined when there is no session. This is
   *  the whole of the composite's own state: chevrons appear across the tree when it is set and
   *  come off when it is cleared, which ADR-0035 makes the entire "editing is available now"
   *  signal — no banner, no mode. Re-renders what is already built; it never re-reads the load
   *  order, so filter state, expansion and scroll position survive a session starting or closing. */
  setSession(pluginFiles: Set<string> | undefined): void {
    this.sessionFiles = pluginFiles && new Set([...pluginFiles].map((f) => f.toLowerCase()));
    this.emitter.fire(undefined);
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    this.emitter.dispose();
  }
}
