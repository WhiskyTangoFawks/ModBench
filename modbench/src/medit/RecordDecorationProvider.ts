import * as vscode from 'vscode';
import type { WorkingTreeState } from './ApiClient';
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
 */
export class RecordDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  constructor(
    private readonly lookup: (plugin: string, origin: string, formKey: string) => WorkingTreeState | undefined,
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
    return undefined;
  }

  /** Fired for exactly one record's resourceUri — see the class doc comment for why this exists
   *  at all rather than following the stateless precedent providers. */
  refresh(uri: vscode.Uri): void {
    this._onDidChangeFileDecorations.fire(uri);
  }
}
