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
  /** Editing's record browser. Satisfied structurally by `PluginTreeProvider`. `getPluginChildren`'s
   *  second parameter is #448's Stack-node hand-off — see `stackPeersOf` below; the composite
   *  never interprets it, only relays it. */
  children: {
    getPluginChildren(pluginFile: string, stackPeers?: StackPeer[]): Promise<TChild[]>;
    getChildren(child: TChild): Promise<TChild[]> | TChild[];
    getTreeItem(child: TChild): vscode.TreeItem;
    onDidChangeTreeData: vscode.Event<TChild | undefined | null>;
    /** #364: the root-level Conflicts node, or undefined while it has nothing to show (no
     *  session, or `SessionStatus.conflictsComputed` still false — `PluginTreeProvider
     *  .conflictsNode`'s own gate, never re-decided here). A `TChild` like every other node the
     *  record side owns, so it is prepended to the root row list, never added to `rowsSeen` — it
     *  routes through this same `children` object for its own `getChildren`/`getTreeItem`, the
     *  same as every node #448's Stack node or any other record-side node would. Optional, same
     *  convention as `stackPeersOf` below: a caller that never wires it just never gets a
     *  Conflicts node prepended. */
    conflictsNode?(): TChild | undefined;
  };
  /** The filename a row stands for, or undefined for a row that stands for no plugin file at all
   *  (an error or empty-state row). The composite's only knowledge of either side's node shapes. */
  pluginFileOf(row: TRow): string | undefined;
  /** #277 / ADR-0037 AC8: the master names this row's own order-aware badge flagged (issue #67,
   *  `PluginListProvider.orderIssueMastersOf`), or undefined/empty for a row that carries none.
   *  Optional — omitted in tests that don't exercise AC8's reconciliation — so a row with a
   *  backend master issue and no wired accessor just gets the backend's own wording, unreconciled. */
  orderIssueMastersOf?(row: TRow): string[] | undefined;
  /** #278 / ADR-0035 amending ADR-0018, reversed in part by #396 / ADR-0035's dated §Filters
   *  amendment: whether this plugin owns at least one record the active record filter matches.
   *  `false` is only ever produced while a filter is active — `RecordQueryService.GetPlugins()`
   *  reports `true` for every plugin whenever no filter is active — so this accessor alone is
   *  what root `getChildren()` reads to omit the row entirely: a filter's whole point is cutting
   *  noise, and a visible-but-inert row is still noise. Optional, and `undefined` from the
   *  accessor's own return (as opposed to the accessor being unwired) means the same as `true` —
   *  no filter machinery to ask means nothing has been ruled out. */
  hasMatchingRecords?(pluginFile: string): boolean | undefined;
  /** #448: this row's own file-level peers — the losers a contested plugin's `fileOverrides()`
   *  entry names (`PluginListProvider.stackPeers()`), or undefined for an uncontested row (no
   *  Stack node to build). Optional, same convention as `orderIssueMastersOf`: a test that
   *  doesn't wire it just never hands a peer list through, which `getPluginChildren` already
   *  treats as "no Stack node" on the Editing side. Read fresh on every expansion, never cached
   *  here — the composite holds no state of its own about the Stack node, exactly like every
   *  other row-level fact in this file. */
  stackPeersOf?(row: TRow): StackPeer[] | undefined;
  /** #449: this plugin's own compile-freshness answer — "source ahead of binary" — keyed the same
   *  way `hasMatchingRecords` is (a plugin filename, not the row), because it changes on its own
   *  independent trigger (Save & Compile) rather than through `setSession`'s once-per-load bundle,
   *  the same reason `hasMatchingRecords` itself lives here rather than in that bundle. Undefined
   *  (accessor not wired, or the plugin isn't in whatever map backs it) reads as "nothing to show"
   *  — the same safe default `hasMatchingRecords` itself falls back to. */
  compilePendingOf?(pluginFile: string): { pending: boolean; lastCompiledAt: string | null } | undefined;
}

/** A plugin's own declared master, absent from the session (#277 / ADR-0037). Structurally
 *  matches `medit/ApiClient.ts`'s `MasterIssue` without importing it — the composite imports
 *  from neither bounded context (`src/test/contextBoundary.test.ts`). `DirectlyMissing`: never
 *  attempted at all. `Unloadable`: attempted, but itself failed to open or parse — not a
 *  transitive fact about a further master; see MasterResolution.Classify (backend) for why
 *  there is nothing to cascade. */
type MasterIssue = { masterName: string; kind: 'DirectlyMissing' | 'Unloadable' };

/** #448: one Stack-node peer — a file-level loser's own (origin, physical path) pair. Structurally
 *  matches `modmanager/unlistedPlugins.ts`'s `UnlistedPlugin` without importing it, the same
 *  precedent `MasterIssue` above already sets — CONTEXT-MAP.md's boundary object (origin +
 *  physical plugin path, ADR-0036) is exactly this shape and nothing richer, so there is nothing
 *  for a structural duplicate to omit. */
export type StackPeer = { name: string; path: string; origin: string };

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
      // #396 / ADR-0035's dated §Filters amendment: a row whose plugin the active filter matches
      // nothing of is omitted here, not merely left unexpandable — see isHiddenByFilter. rowsSeen
      // only ever needs to remember rows actually handed out; a hidden row is never asked about by
      // getTreeItem (VS Code's own contract: it only calls getTreeItem with an element a
      // getChildren returned), so leaving it out of rowsSeen too is not a separate decision.
      const visible = rows.filter((row) => !this.isHiddenByFilter(row));
      for (const row of visible) this.rowsSeen.add(row as object);
      // #364: prepended, never added to rowsSeen — it is a TChild the record side owns (see the
      // deps doc comment), not a TRow, so isRow(element) must keep answering false for it the same
      // way it already does for every other record-side node.
      const conflicts = this.deps.children.conflictsNode?.();
      return conflicts === undefined ? visible : [conflicts, ...visible];
    }
    if (!this.isRow(element)) return this.deps.children.getChildren(element as TChild);
    const file = this.expandableFile(element as TRow);
    if (file === undefined) return [];
    return this.deps.children.getPluginChildren(file, this.deps.stackPeersOf?.(element as TRow));
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
    // #276 / ADR-0035, extended by #277 / ADR-0037: read-only-for-editing, the load-failure
    // decoration and the master-issue decoration are all decided here for the same reason the
    // chevron is — this is the one place allowed to know both what the row provider built and
    // what the session says, so neither side has to learn the other's vocabulary. Tooltip and (for
    // the error decorations only) icon/description — never the leading slot (checkbox/lock,
    // #276), which answers exactly one question ("can you change whether this loads?") that none
    // of this is part of, and never contextValue: #356 retired the one decoration (drift) that
    // ever needed to gate a per-row command through it.
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

  /** Each row's own tooltip, description and icon, captured the first time this composite
   *  renders it — `getTreeItem` restores to (or builds on top of) this on every subsequent
   *  render, since the row it decorates is the same mutable object the tree keeps reusing.
   *  Both real row providers return the row *as* its own TreeItem (`getTreeItem(el) { return el;
   *  }`), so naively appending a note would accumulate it permanently the first time a plugin is
   *  decorated, with no way back to the row provider's own tooltip/icon/description (e.g.
   *  `PluginNode`'s own missing-master badge) once the condition clears. #276 hit exactly this
   *  bug for tooltip alone; the error decorations below touch icon and description too, so all
   *  three are captured and restored together. Weak for the same reason as `rowsSeen`. */
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

  /** #276 / ADR-0035 AC4/AC5: appends a note to whatever tooltip `item` already carries — never
   *  replaces it, so a row's own badge (e.g. `PluginNode`'s missing-master one) survives. */
  private applyReadOnlyNote(item: vscode.TreeItem, file: string | undefined): void {
    const readOnly = file !== undefined && (this.readOnlyFiles?.has(file) ?? false);
    if (!readOnly) return;
    const note = `This plugin is read-only — its records can't be edited.`;
    // A MarkdownString base would be replaced here, not appended to — no row provider produces
    // one today, so this is a documented assumption, not a bug to handle.
    item.tooltip = typeof item.tooltip === 'string' ? `${item.tooltip}\n${note}` : note;
  }

  /** #277 / ADR-0037: the backend-derived error decorations — AC7's load failure and AC1/AC2/AC4's
   *  master issues — take decoration authority for a row only when the backend actually has
   *  something to say about it; otherwise `item` is left exactly as `captureOriginalDecoration`
   *  restored it (including a frontend-only order-aware badge, untouched — see AC8 below). Both
   *  branches read their session maps with `?? []`/an explicit undefined check rather than a bare
   *  `.get(...).x` — the wire's `masterIssues` is `MasterIssue[] | undefined | null` even though
   *  the backend always emits an array once #277 ships, and a response from a backend predating
   *  the field must degrade to "no issues", not throw. */
  private applyBackendDecoration(item: vscode.TreeItem, row: TRow, file: string | undefined): void {
    // AC7: a plugin that failed to open or parse never has a MasterMetadata to derive an issue
    // list from (MasterResolution.Classify only iterates the successfully-loaded set), so this
    // and the master-issue decoration below are mutually exclusive per plugin — checked first as
    // the more fundamental fact: nothing about a plugin's own masters could even be evaluated.
    const failureReason = file !== undefined ? this.loadFailures?.get(file) : undefined;
    if (failureReason !== undefined) {
      item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'));
      item.description = '✗ Failed to load';
      const note = `Failed to load: ${failureReason}`;
      item.tooltip = typeof item.tooltip === 'string' ? `${item.tooltip}\n${note}` : note;
    } else {
      const issues = file !== undefined ? (this.masterIssues?.get(file) ?? []) : [];
      if (issues.length > 0) this.applyMasterIssueDecoration(item, row, issues);
    }

    // #449: unconditional, unlike the two branches above — it never steals the icon slot from a
    // higher-severity decoration (orchestrator ruling), so it has nothing to be mutually exclusive
    // with. It only ever appends to whatever description/tooltip text this row already carries,
    // including text either branch above just set.
    this.applyCompilePendingDecoration(item, file);
  }

  /** #449: a tracked plugin whose source has moved past `refs/medit/last-compile/<plugin>` —
   *  "the game can't see your edits yet". Session-derived like the master-issue/load-failure
   *  decorations above (append-only, never the leading slot), but never claims `iconPath` — the
   *  description hint is the primary signal, and the icon slot stays reserved for whichever
   *  higher-severity decoration (if any) already claimed it above. */
  private applyCompilePendingDecoration(item: vscode.TreeItem, file: string | undefined): void {
    const freshness = file !== undefined ? this.deps.compilePendingOf?.(file) : undefined;
    if (!freshness?.pending) return;

    const when = freshness.lastCompiledAt ? new Date(freshness.lastCompiledAt).toLocaleString() : 'unknown';
    const note = `Source ahead of binary — last compiled ${when}`;
    item.tooltip = typeof item.tooltip === 'string' ? `${item.tooltip}\n${note}` : note;

    const hint = '⟳ Compile pending';
    item.description = item.description ? `${item.description} · ${hint}` : hint;
  }

  /** AC1/AC2/AC4/AC8: one decoration, not two that can disagree. A master name the backend also
   *  flags is reported once, in the backend's richer session-aware wording; a master the
   *  frontend's order-only check (issue #67) flagged that the backend does *not* — present,
   *  loaded, merely sequenced too late, a fact Mutagen's own FormKey resolution has no way to see
   *  — is preserved, worded distinctly. Built structurally from `issues` and
   *  `orderIssueMastersOf`, never by editing the row's own pre-rendered text, so there is nothing
   *  to double up or corrupt. */
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

  /** Each row's own tooltip, description and icon, captured the first time this composite
   *  renders it — `captureOriginalDecoration` restores to (or builds on top of) this on every
   *  subsequent render, since the row it decorates is the same mutable object the tree keeps
   *  reusing. Weak for the same reason as `rowsSeen`. */
  private readonly originalDecoration = new WeakMap<object, {
    tooltip: string | vscode.MarkdownString | undefined;
    description: vscode.TreeItem['description'];
    iconPath: vscode.TreeItem['iconPath'];
  }>();

  private isRow(element: TRow | TChild): boolean {
    return this.rowsSeen.has(element as object);
  }

  /** #97 / ADR-0035 § Live mutation: whether a backend session is currently loaded — the same fact
   *  `expandableFile` below already gates the chevron on, exposed so the composition root can
   *  decide whether a load-order mutation (a checkbox toggle) has a running session to apply
   *  itself to at all, before ever attempting the call. Mod Management works with no backend
   *  running (root CLAUDE.md), which is the ordinary case, not a failure — so this is checked
   *  rather than let a doomed request surface as a network-error toast for an entirely normal
   *  loadout-only session. */
  hasSession(): boolean {
    return this.sessionFiles !== undefined;
  }

  /** The plugin file this row can browse, or undefined when it can't be expanded — no session, no
   *  plugin file, or a file the session doesn't hold. A row whose filter match is `false` never
   *  reaches here at all (#396: `getChildren()` omits it before `getTreeItem`/`getChildren(row)`
   *  can be called on it — VS Code's own contract guarantees neither is called with an element
   *  `getChildren` didn't return), so there is nothing left for this method itself to rule out on
   *  that account. The empty-session case is the honest answer for the same underlying reason a
   *  filtered-out row used to be here: a row that would expand to an empty list reads as "this
   *  plugin has no records" (ADR-0026's silent-wrong-state tier), whether the emptiness comes from
   *  never having been indexed or (now handled one level up) from every record being filtered out. */
  private expandableFile(row: TRow): string | undefined {
    if (this.sessionFiles === undefined) return undefined;
    const file = this.deps.pluginFileOf(row);
    return file === undefined || !this.sessionFiles.has(file.toLowerCase()) ? undefined : file;
  }

  /** #396 / ADR-0035's dated §Filters amendment: true for a row whose plugin the active record
   *  filter matches zero records of. `hasMatchingRecords` only ever answers `false` while a filter
   *  is active (`RecordQueryService.GetPlugins()` reports `true` for every plugin otherwise), so
   *  reading it here — with no separate "is a filter active" signal threaded in — is sufficient. A
   *  row with no plugin file at all (an error/empty-state row) is never hidden by this: there is
   *  nothing for a record filter to have an opinion about. */
  private isHiddenByFilter(row: TRow): boolean {
    const file = this.deps.pluginFileOf(row);
    return file !== undefined && this.deps.hasMatchingRecords?.(file) === false;
  }

  private sessionFiles?: Set<string>;
  private readOnlyFiles?: Set<string>;
  private masterIssues?: Map<string, MasterIssue[]>;
  private loadFailures?: Map<string, string>;

  /** The plugin files the editing session holds, or undefined when there is no session, plus
   *  (#276 / ADR-0035) the subset that's read-only for editing — Editing's "Immutable plugin"
   *  (`medit/ApiClient.ts` `PluginMetadata.isImmutable`) — and (#277 / ADR-0037) each plugin's own
   *  master issues, keyed by plugin filename (`medit/ApiClient.ts` `PluginMetadata.masterIssues`),
   *  plus (also #277 / ADR-0037 AC7) the reason for every plugin the session tried and failed to
   *  load at all (`SessionLoadResponse.failures`, already crossed the wire — no new endpoint).
   *  One setter, not four: these facts are a single hand-off from the same session and never
   *  change independently — every call site in `extension.ts` either sets all of them (session
   *  start) or clears all of them (session close, backend gone), so separately-callable setters
   *  would only be a coupling something could call apart by mistake. `readOnlyFiles`,
   *  `masterIssues` and `loadFailures` all default to empty, so existing shorter-argument callers
   *  are unaffected.
   *
   *  This is the whole of the composite's own state: chevrons appear across the tree when a
   *  session is set and come off when it is cleared, which ADR-0035 makes the entire "editing is
   *  available now" signal — no banner, no mode. Re-renders what is already built; it never
   *  re-reads the load order, so filter state, expansion and scroll position survive a session
   *  starting or closing. */
  setSession(
    pluginFiles: Set<string> | undefined,
    readOnlyFiles: Set<string> = new Set(),
    masterIssues: Map<string, MasterIssue[]> = new Map(),
    loadFailures: Map<string, string> = new Map(),
  ): void {
    this.sessionFiles = pluginFiles && new Set([...pluginFiles].map((f) => f.toLowerCase()));
    this.readOnlyFiles = pluginFiles && new Set([...readOnlyFiles].map((f) => f.toLowerCase()));
    this.masterIssues = pluginFiles && new Map([...masterIssues].map(([name, issues]) => [name.toLowerCase(), issues]));
    this.loadFailures = pluginFiles && new Map([...loadFailures].map(([name, reason]) => [name.toLowerCase(), reason]));
    this.emitter.fire(undefined);
  }

  /** Re-render what is already built, because something this composite *layers on* changed — e.g.
   *  #278's record-filter match set. Deliberately not the row provider's `invalidate()`, which
   *  means "re-read plugins.txt from disk": callers of this reach for it precisely because nothing
   *  about the load order itself changed, and re-reading would hand out a fresh set of row
   *  objects, discarding the per-row decoration state keyed to the old ones (`originalDecoration`)
   *  and losing the tree's selection with it. Same distinction `PluginListProvider` already draws
   *  internally between `invalidate()` and `render()`, surfaced here because the trigger now lives
   *  outside it. */
  refreshDecorations(): void {
    this.emitter.fire(undefined);
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    this.emitter.dispose();
  }
}
