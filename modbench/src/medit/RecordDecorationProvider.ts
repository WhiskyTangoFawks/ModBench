import * as vscode from 'vscode';
import type { WorkingTreeState, ConflictAll } from './ApiClient';
import { parseRecordResourceUri } from './recordResourceUri';

/**
 * #428: record-row M/A badges — VS Code's own git-idiom vocabulary (single-letter badge, the
 * exact `gitDecoration.*ResourceForeground` theme colours git's own decorations use), via a
 * `FileDecorationProvider` keyed on {@link recordResourceUri}'s synthetic scheme.
 *
 * Deleted is not a value here (orchestrator ruling on #428's plan gate, follow-up filed
 * separately): a working-tree-deleted record has no row in the Plugins tree to badge at all —
 * `Search()` is Effective-only, and a deleted record has no Effective row (the backend's own
 * `RecordSummaryWorkingTreeStateTests` and `WorkingTreeState`'s doc comment pin this). This
 * mirrors VS Code's own Explorer, which drops a deleted file's row rather than badging it D; the
 * native Source Control panel (already registered per tracked mod, `version-control` spec) shows
 * that D today for free.
 *
 * Stateless *reads* — `lookup` is a live accessor into `PluginTreeProvider`'s own cache, the same
 * DI-callback shape `HiddenDownloadDecorationProvider`/`ImplicitMasterDecorationProvider` already
 * use — but not a stateless *provider* the way those two are: this one owns a real
 * `onDidChangeFileDecorations` emitter (see {@link refresh}), because unlike a hidden-download or
 * implicit-master flag (which only ever changes in lockstep with a `TreeDataProvider` refresh this
 * codebase's own tree-redraw-requeries-decorations doctrine already covers), a field edit does
 * *not* redraw the tree at all (#428 Q1 ruling — a full page-cache invalidation per committed cell
 * edit is a refetch storm) yet still has to flip a badge on an already-rendered row. `refresh`
 * exists for exactly that gap: `FileDecorationProvider` re-queries independently of any tree
 * redraw when fired for a URI, so the badge updates with zero network cost.
 *
 * **Committing or reverting through the native Source Control panel pushes no live signal here**
 * (#428 Q2, orchestrator gate ruling — punt approved, stated rather than hidden). Nothing in this
 * extension retains the `Repository` handle `openRepository` returns or subscribes to its
 * `state.onDidChange`, so a badge set by a Modbench-driven edit only clears (or a badge a native
 * commit/revert should have changed only updates) at the next Modbench-driven read — the same
 * no-watcher posture the record editor and compare grid already carry (#413's own "reverting
 * through git restores the committed value at the next read"). Live reactivity to bare git-panel
 * activity is a follow-up (repo-handle plumbing), not this ticket.
 *
 * **#364: the record conflict badge shares this same URI-keyed provider** rather than a second
 * one — a row has exactly one `FileDecoration`, so the two badges have to be reconciled in one
 * place, not painted independently and left to whichever provider VS Code asks last. `lookup`
 * (M/A) always wins when it has an answer: an uncommitted local edit is the more actionable,
 * load order-local fact, and the orchestrator's #364 plan-gate ruling made this the explicit default
 * rather than leaving it to whichever check happened to run first. `conflictAllLookup` is
 * consulted only when `lookup` has nothing to say, and it is expected to already apply #307's own
 * gate (`PluginTreeProvider.conflictAllOf` does — undefined while `conflictsComputed` is false or
 * for a record nothing has fetched a conflict state for yet) — this provider does not re-decide
 * that itself, only renders what it's told. OnlyOne/NoConflict never badge either
 * (`medit-record-editor.md`'s "no tint" rule, reused here as "no badge"): a badge is reserved for
 * "this needs attention", not for every record with more than one plugin's opinion on file.
 *
 * **#364 review finding: the conflict lookup only ever runs for a URI `parseRecordResourceUri`
 * marks `fromConflictsNode`.** `conflictAllLookup` is keyed purely on (plugin, origin, formKey) —
 * the same record shown via an ordinary `RecordTypeNode -> RecordNode` row elsewhere in the tree
 * resolves to the identical lookup key, so without this gate that row would inherit a badge that
 * belongs only to its Conflicts-node row (the AC's explicit scope — Option B's "badge everywhere"
 * was deliberately not built). The marker, not the lookup's own cache, is what closes this: the
 * cache stays a plain identity map (one conflictAll per record is still a true fact regardless of
 * who asks), but only a Conflicts-node-built row's URI ever asks.
 */
export class RecordDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  constructor(
    private readonly lookup: (plugin: string, origin: string, formKey: string) => WorkingTreeState | undefined,
    private readonly conflictAllLookup?: (plugin: string, origin: string, formKey: string) => ConflictAll | undefined,
  ) {}

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const identity = parseRecordResourceUri(uri);
    if (!identity) return undefined;
    const state = this.lookup(identity.plugin, identity.origin, identity.formKey);
    if (state === 'Modified') {
      return { badge: 'M', color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'), tooltip: 'Modified' };
    }
    if (state === 'Added') {
      return { badge: 'A', color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'), tooltip: 'Added' };
    }
    // #364 review finding: never even attempt a conflict lookup for a row outside the Conflicts
    // node — see the class doc comment.
    if (!identity.fromConflictsNode) return undefined;
    return this.conflictDecoration(identity.plugin, identity.origin, identity.formKey);
  }

  /** #364: ADR-0016's Axis 1 only (record-wide ConflictAll) — Axis 2 (per-cell ConflictThis) is
   *  the compare grid's own concern, never this tree's. Colours reuse existing sanctioned tokens
   *  rather than inventing new ones, matching the compare grid's own "no new colors" rule
   *  (ADR-0016's 2026-08-11 update): green/red are the same tokens the M/A badges above already
   *  use, and `gitDecoration.conflictingResourceForeground` is VS Code's own semantic "conflict"
   *  token, unused anywhere else in this codebase. */
  private conflictDecoration(plugin: string, origin: string, formKey: string): vscode.FileDecoration | undefined {
    const conflictAll = this.conflictAllLookup?.(plugin, origin, formKey);
    switch (conflictAll) {
      case 'Override':
        return { badge: 'O', color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'), tooltip: 'Override' };
      case 'Conflict':
        return { badge: 'C', color: new vscode.ThemeColor('gitDecoration.conflictingResourceForeground'), tooltip: 'Conflict' };
      case 'ConflictCritical':
        return { badge: '!', color: new vscode.ThemeColor('problemsErrorIcon.foreground'), tooltip: 'Conflict (critical)' };
      default:
        // OnlyOne, NoConflict, or undefined (not computed / not fetched) — #307: nothing rendered,
        // never a badge that could be mistaken for "no conflict".
        return undefined;
    }
  }

  /** Fired for exactly one record's resourceUri — see the class doc comment for why this exists
   *  at all rather than following the stateless precedent providers. */
  refresh(uri: vscode.Uri): void {
    this._onDidChangeFileDecorations.fire(uri);
  }
}
