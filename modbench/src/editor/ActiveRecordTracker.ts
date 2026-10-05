import * as vscode from 'vscode';

/** Reports only the active panel's FormKey; a background panel retargeting updates the map
 *  silently. Generic over panel identity so the caller owns the VS Code `active` transition and
 *  this class needs no VS Code harness. */
export class ActiveRecordTracker<TPanel = unknown> {
  private readonly _onDidChangeActiveRecord = new vscode.EventEmitter<string | undefined>();
  readonly onDidChangeActiveRecord = this._onDidChangeActiveRecord.event;

  private readonly formKeys = new Map<TPanel, string>();
  private active: TPanel | undefined;
  private lastFired: string | undefined;

  current(): string | undefined {
    return this.lastFired;
  }

  /** Any tracked panel's own FormKey, active or not — the notification subscription's per-panel
   *  match key. */
  formKeyOf(panel: TPanel): string | undefined {
    return this.formKeys.get(panel);
  }

  /** Fires only if `panel` is the active one. */
  setFormKey(panel: TPanel, formKey: string): void {
    this.formKeys.set(panel, formKey);
    if (panel === this.active) this.fire(formKey);
  }

  /** A no-op when `panel` is already active: VS Code can report the same panel active twice,
   *  and that must not force a Referenced By refetch. */
  setActivePanel(panel: TPanel | undefined): void {
    if (panel === this.active) return;
    this.active = panel;
    this.fire(panel === undefined ? undefined : this.formKeys.get(panel));
  }

  /** The record tab last in focus; none once it closes. */
  activePanel(): TPanel | undefined {
    return this.active;
  }

  /** VS Code has no "last record tab closed" event, so firing `undefined` then is this class's job.
   *  A closing active tab with others open keeps its record until another tab gains focus. */
  removePanel(panel: TPanel): void {
    this.formKeys.delete(panel);
    if (panel === this.active) this.active = undefined;
    if (this.formKeys.size === 0) this.fire(undefined);
  }

  private fire(formKey: string | undefined): void {
    this.lastFired = formKey;
    this._onDidChangeActiveRecord.fire(formKey);
  }
}
