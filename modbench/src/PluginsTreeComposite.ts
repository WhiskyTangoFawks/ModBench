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
  /** #277 / ADR-0037 AC8: the master names this row's own order-aware badge flagged (issue #67,
   *  `PluginListProvider.orderIssueMastersOf`), or undefined/empty for a row that carries none.
   *  Optional — omitted in tests that don't exercise AC8's reconciliation — so a row with a
   *  backend master issue and no wired accessor just gets the backend's own wording, unreconciled. */
  orderIssueMastersOf?(row: TRow): string[] | undefined;
  /** #331: the pending-change decoration identity URI for a plugin row, given its filename — the
   *  composite holds no opinion on the scheme itself (that's `medit/pendingChangeRowUri.ts`,
   *  wired in by `extension.ts`; importing it here would violate `src/test/contextBoundary.test.ts`'s
   *  "imports nothing from either context" rule), it only knows *that* a row may need one, the
   *  same shape as `orderIssueMastersOf` above. Optional — omitted in tests that don't exercise
   *  this. `undefined` from the accessor itself (as opposed to the accessor being absent) means
   *  "no plugin filename to build one from" (an error/empty-state row). */
  pendingChangeUriOf?(pluginFile: string): vscode.Uri | undefined;
  /** #279 / ADR-0035 § Live mutation: this plugin's drift, or `undefined` for one that has not
   *  drifted **or** that nothing is currently known about. `pluginDrift.ts` deliberately makes
   *  those one value, so it is not a distinction this composite could render even if it wanted to
   *  — which is how #334's rule (an absent marker must never be produced by a failed computation)
   *  is kept here: a failure never reaches this accessor as an answer. Optional and the same shape
   *  as the accessors above; omitted in tests that don't exercise drift. */
  driftOf?(pluginFile: string): PluginDrift | undefined;
  /** #278 / ADR-0035 amending ADR-0018: whether this plugin owns at least one record the active
   *  record filter matches. A record filter narrows records and record types, never plugin rows
   *  — this is the one thing it is allowed to change about a row, and only via the chevron: a
   *  plugin with no matches stays visible, it just doesn't expand onto an empty list. Optional,
   *  and `undefined` from the accessor's own return (as opposed to the accessor being unwired)
   *  means the same as `true` — no filter machinery to ask means nothing has been ruled out. */
  hasMatchingRecords?(pluginFile: string): boolean | undefined;
}

/** A plugin whose name no longer resolves to the file its records were read from (#279 /
 *  ADR-0035 § Live mutation). Structurally matches `pluginDrift.ts`'s own `PluginDrift` without
 *  importing it: this file imports nothing but `vscode`, and `src/test/contextBoundary.test.ts`
 *  holds it to that for the composition root's own modules as much as for either context's.
 *  `currentOrigin: null` means the name resolves to nothing at all — the one drift no re-read can
 *  repair, since there is no file to read. */
type PluginDrift = { loadedOrigin: string; currentOrigin: string | null; currentPath: string | null };

/** A plugin's own declared master, absent from the session (#277 / ADR-0037). Structurally
 *  matches `medit/ApiClient.ts`'s `MasterIssue` without importing it — the composite imports
 *  from neither bounded context (`src/test/contextBoundary.test.ts`). `DirectlyMissing`: never
 *  attempted at all. `Unloadable`: attempted, but itself failed to open or parse — not a
 *  transitive fact about a further master; see MasterResolution.Classify (backend) for why
 *  there is nothing to cascade. */
type MasterIssue = { masterName: string; kind: 'DirectlyMissing' | 'Unloadable' };

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
    // #276 / ADR-0035, extended by #277 / ADR-0037: read-only-for-editing, the load-failure
    // decoration and the master-issue decoration are all decided here for the same reason the
    // chevron is — this is the one place allowed to know both what the row provider built and
    // what the session says, so neither side has to learn the other's vocabulary. Tooltip and (for
    // the error decorations only) icon/description, plus — since #279 — a contextValue, but still
    // never the leading slot (checkbox/lock, #276), which answers exactly one question ("can you
    // change whether this loads?") that none of this is part of.
    //
    // #279 is what changed the contextValue half. This comment previously read "never a
    // contextValue", on the stated grounds that no per-row editing command existed to gate off
    // one; Re-read is the first, so the reason expired rather than the rule being broken. It stays
    // the *only* one: a contextValue here must correspond to a command in package.json's
    // `view/item/context`, or it is dead weight that silently widens some other clause.
    const base = this.captureOriginalDecoration(element as object, item);
    item.tooltip = base.tooltip;
    item.description = base.description;
    item.iconPath = base.iconPath;
    item.contextValue = base.contextValue;

    const rawFile = this.deps.pluginFileOf(element as TRow);
    const file = rawFile?.toLowerCase();
    this.applyReadOnlyNote(item, file);
    this.applyBackendDecoration(item, element as TRow, file);
    this.applyDriftDecoration(item, rawFile);
    this.applyPendingChangeUri(item, rawFile);

    return item;
  }

  /** #279 / ADR-0035 § Live mutation: the row states that the file behind it changed, and becomes
   *  a re-read target when there is something to re-read.
   *
   *  Applied *after* the backend decorations and deliberately additive: it appends its own tooltip
   *  line and takes icon/description only if nothing more fundamental already claimed them. A
   *  plugin that failed to load outright, or that is missing a master, has something wrong with it
   *  that outranks where its bytes came from — but drift is still true of it, still worth saying,
   *  and still re-readable, so it is never suppressed, only out-ranked in the one slot each.
   *
   *  Note this runs only with a session: with none there is no loaded origin for a current one to
   *  differ from, so `driftOf` has nothing to answer and the row is left alone. */
  private applyDriftDecoration(item: vscode.TreeItem, file: string | undefined): void {
    if (file === undefined || this.sessionFiles === undefined) return;
    const drift = this.deps.driftOf?.(file);
    if (drift === undefined) return;

    // AC3: both origins, named. The wording says "would now resolve to" rather than "does" on
    // purpose — nothing has been re-read, so the loaded origin is still the one being served.
    const wouldResolveTo = drift.currentOrigin ?? 'nothing';
    const note = `This plugin's file changed: loaded from ${drift.loadedOrigin}, would now resolve to ${wouldResolveTo}.`;
    item.tooltip = typeof item.tooltip === 'string' ? `${item.tooltip}\n${note}` : note;
    item.description ??= '⚠ Drifted';
    item.iconPath ??= new vscode.ThemeIcon('warning');

    // The gate on the Re-read command (package.json `view/item/context`). Only when there is a
    // file to read: a plugin whose name now resolves to nothing still flags and still says so in
    // its tooltip, but offering to re-read it would be offering to read nothing.
    if (drift.currentPath !== null) item.contextValue = 'pluginDrifted';
  }

  /** #331: a plugin row's pending-change decoration identity, deferring to whatever `resourceUri`
   *  the row provider already set. `ImplicitMasterNode` (`modmanager/PluginListProvider.ts`)
   *  already sets one of its own — a real `Data/<name>` filesystem path consumed exclusively by
   *  `ImplicitMasterDecorationProvider` to gray a forced-loaded master's label — and `resourceUri`
   *  is single-valued, so overwriting it here would silently break that unrelated decoration.
   *  Implicit/forced-master rows are therefore out of scope for pending-change decoration (their
   *  contained records still decorate individually, through RecordNode's own, unconflicting
   *  scheme) — a deliberate exclusion (#331 review), not a gap to "fix" by clobbering the
   *  existing assignment. */
  private applyPendingChangeUri(item: vscode.TreeItem, file: string | undefined): void {
    if (item.resourceUri !== undefined || file === undefined) return;
    item.resourceUri = this.deps.pendingChangeUriOf?.(file);
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
    contextValue: string | undefined;
  } {
    if (!this.originalDecoration.has(key)) {
      this.originalDecoration.set(key, {
        tooltip: item.tooltip,
        description: item.description,
        iconPath: item.iconPath,
        // #279: captured for the same reason as the other three. A drifted row's contextValue is
        // overwritten to gate the Re-read command, so without the row's own value recorded here a
        // re-read that *resolves* the drift would leave the row claiming to be drifted forever —
        // and, worse, still matching the menu clause that offers to re-read it again.
        contextValue: item.contextValue,
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
      item.iconPath = new vscode.ThemeIcon('error');
      item.description = '✗ Failed to load';
      const note = `Failed to load: ${failureReason}`;
      item.tooltip = typeof item.tooltip === 'string' ? `${item.tooltip}\n${note}` : note;
      return;
    }

    const issues = file !== undefined ? (this.masterIssues?.get(file) ?? []) : [];
    if (issues.length > 0) this.applyMasterIssueDecoration(item, row, issues);
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
    item.iconPath = new vscode.ThemeIcon('error');
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
    contextValue: string | undefined;
  }>();

  private isRow(element: TRow | TChild): boolean {
    return this.rowsSeen.has(element as object);
  }

  /** The plugin file this row can browse, or undefined when it can't be expanded — no session, no
   *  plugin file, a file the session doesn't hold, or (#278 / ADR-0035 amending ADR-0018) an active
   *  record filter that matches none of this plugin's records. That last case is the row-visible,
   *  chevron-only half of the amendment: the row itself is never removed by a record filter — only
   *  `getTreeItem`'s decision to render it collapsible is. The empty-session case is the honest one
   *  for the same underlying reason: a row that would expand to an empty list reads as "this plugin
   *  has no records" (ADR-0026's silent-wrong-state tier), whether the emptiness comes from never
   *  having been indexed or from every record having been filtered out. */
  private expandableFile(row: TRow): string | undefined {
    if (this.sessionFiles === undefined) return undefined;
    const file = this.deps.pluginFileOf(row);
    if (file === undefined || !this.sessionFiles.has(file.toLowerCase())) return undefined;
    return this.deps.hasMatchingRecords?.(file) === false ? undefined : file;
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

  /** #279: re-render what is already built, because something this composite *layers on* changed —
   *  today, drift. Deliberately not the row provider's `invalidate()`, which means "re-read
   *  plugins.txt from disk": a mod-level change alters no line of the load order, and re-reading
   *  would hand out a fresh set of row objects, discarding the per-row decoration state keyed to
   *  the old ones (`originalDecoration`) and losing the tree's selection with it. Same distinction
   *  `PluginListProvider` already draws internally between `invalidate()` and `render()`, surfaced
   *  here because the trigger now lives outside it. */
  refreshDecorations(): void {
    this.emitter.fire(undefined);
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    this.emitter.dispose();
  }
}
