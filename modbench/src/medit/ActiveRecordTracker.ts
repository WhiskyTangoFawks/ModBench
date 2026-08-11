import * as vscode from 'vscode';

/** Tracks which open record panel is active and what FormKey each one currently shows, and
 *  reports the *active* one's FormKey whenever either changes — the input the "Referenced By"
 *  view retargets on (#282), in place of the old `modbench.showReferencedBy` command argument.
 *
 *  Deliberately generic over the panel's identity (`TPanel`, an opaque token) rather than typed
 *  to `vscode.WebviewPanel` — this class never reads `.active`/`.onDidChangeViewState` itself,
 *  extension.ts's wiring does, and passes the already-resolved panel + its `active` transition
 *  in. That keeps this class testable with plain object identities, no VS Code harness, and
 *  keeps it agnostic to #284 giving "a record panel" a richer shape later — anything usable as a
 *  Map key works.
 *
 *  Only the *active* panel's FormKey is ever reported — a background panel retargeting itself
 *  (e.g. the main panel navigating while a "Beside" one has focus) updates the map silently and
 *  fires nothing until it becomes active. */
export class ActiveRecordTracker<TPanel = unknown> {
  private readonly _onDidChangeActiveRecord = new vscode.EventEmitter<string | undefined>();
  readonly onDidChangeActiveRecord = this._onDidChangeActiveRecord.event;

  private readonly formKeys = new Map<TPanel, string>();
  private activePanel: TPanel | undefined;
  private lastFired: string | undefined;

  /** The active panel's currently known FormKey, without subscribing — the tree provider's
   *  initial state before its first `onDidChangeActiveRecord` fire. */
  current(): string | undefined {
    return this.lastFired;
  }

  /** Records `panel`'s currently displayed FormKey — called from `openRecordPanel`'s create and
   *  reuse-and-retarget branches alike. Fires only if `panel` is the active one. */
  setFormKey(panel: TPanel, formKey: string): void {
    this.formKeys.set(panel, formKey);
    if (panel === this.activePanel) this.fire(formKey);
  }

  /** Records which panel is active — `undefined` when no record panel is open/focused at all.
   *  Fires with that panel's tracked FormKey (or `undefined` if it has none yet). A no-op when
   *  `panel` is already the active one — VS Code can report the same panel active more than
   *  once (e.g. a redundant `onDidChangeViewState`), and that must not force a redundant
   *  Referenced By retarget/refetch. */
  setActivePanel(panel: TPanel | undefined): void {
    if (panel === this.activePanel) return;
    this.activePanel = panel;
    this.fire(panel === undefined ? undefined : this.formKeys.get(panel));
  }

  /** Forgets a closed panel — called from its `onDidDispose`. Firing `undefined` when it was the
   *  active one is this class's own responsibility: VS Code has no "the active panel just closed"
   *  event to rely on for that. */
  removePanel(panel: TPanel): void {
    this.formKeys.delete(panel);
    if (panel === this.activePanel) {
      this.activePanel = undefined;
      this.fire(undefined);
    }
  }

  private fire(formKey: string | undefined): void {
    this.lastFired = formKey;
    this._onDidChangeActiveRecord.fire(formKey);
  }
}
