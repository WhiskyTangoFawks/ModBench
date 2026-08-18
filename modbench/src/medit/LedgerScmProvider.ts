import * as vscode from 'vscode';
import type { PluginRepository } from './PluginRepository';
import type { LedgerStatusEntry, LedgerChangeKind } from './ApiClient';

/** #368: the single Modbench source-control provider on the native Source Control panel —
 *  ADR-0040/#366 rejected one provider per plugin (the header-row cost doesn't scale), so this is
 *  the one aggregate instance the extension constructs. Native-first (ADR-0027): `vscode.scm`,
 *  `SourceControlResourceGroup`/`ResourceState`, `FileDecorationProvider` and
 *  `TextDocumentContentProvider` are the platform's own answers for a working-tree panel, a
 *  changed-row badge, and a diff's "original" side respectively — nothing here is bespoke chrome.
 *
 *  Read-only in this stage (#368 binding constraint): no staging, reverting or committing from the
 *  panel — clicking a resource only opens a diff. Working-tree group only; branch groups are
 *  #378/#379/#380.
 */
export const LEDGER_SOURCE_CONTROL_ID = 'modbench.ledger';
export const LEDGER_SOURCE_CONTROL_LABEL = 'Modbench';
export const LEDGER_WORKING_TREE_GROUP_ID = 'workingTree';
// Copies git's own resource-group naming for this exact concept (see the native SCM provider
// guide's own worked example: `createResourceGroup('workingTree', 'Changes')`) rather than
// inventing a Modbench-specific label for a VS Code idiom users already know.
export const LEDGER_WORKING_TREE_GROUP_LABEL = 'Changes';
export const LEDGER_OPEN_DIFF_COMMAND = 'modbench.ledger.openDiff';
// The diff's "committed" side has no file of its own (it exists only in git history) — this
// scheme's TextDocumentContentProvider (this same class) serves it from the already-fetched
// status payload, so opening a diff costs no further round trip.
export const LEDGER_COMMITTED_SCHEME = 'modbench-ledger-committed';

function tooltipFor(kind: LedgerChangeKind): string {
  switch (kind) {
    case 'Modified': return 'Modified';
    case 'Added': return 'Added';
    case 'Deleted': return 'Deleted';
    case 'Renamed': return 'Renamed';
    default: return 'Changed';
  }
}

// #368 review finding 3: SourceControlResourceState has no label field — VS Code derives the row
// text from resourceUri (basename + containing folder as context, the native list-mode SCM
// rendering), so a row actually reads as its ledger filename ("000800.yaml"), not
// "{recordType} {formKey}". Reshaping the ledger path to force a friendlier basename is out —
// that path is committed history #370/#371 depend on — and inventing a label mechanism would
// fight the native surface (root CLAUDE.md's native-first invariant). The full identity instead
// goes where SourceControlResourceDecorations genuinely supports it: the row's hover tooltip.
function resourceTooltipFor(entry: LedgerStatusEntry): string {
  return `${entry.recordType} ${entry.formKey} · ${entry.plugin} (${tooltipFor(entry.changeKind)})`;
}

// Git's own SCM extension badge vocabulary — only 'Modified' is reachable through today's write
// paths (see LedgerChangeKind's own remarks, MEditService.Core.Ledger), the rest read honestly
// for whichever future write path or external edit eventually produces them.
function badgeFor(kind: LedgerChangeKind): string {
  switch (kind) {
    case 'Modified': return 'M';
    case 'Added': return 'A';
    case 'Deleted': return 'D';
    case 'Renamed': return 'R';
    default: return 'U';
  }
}

/** Identifies a status entry's committed-text virtual document — plugin/recordType/formKey is
 *  already this entry's own unique identity (LedgerRecordPath, backend), reused rather than
 *  minting a second one. */
function committedUriFor(entry: LedgerStatusEntry): vscode.Uri {
  return vscode.Uri.from({
    scheme: LEDGER_COMMITTED_SCHEME,
    path: `/${encodeURIComponent(entry.plugin)}/${encodeURIComponent(entry.recordType)}/${encodeURIComponent(entry.formKey)}`,
  });
}

export class LedgerScmProvider implements vscode.FileDecorationProvider, vscode.TextDocumentContentProvider {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  // #368 review finding 4: a diff tab left open must not keep showing stale committed text after a
  // later refresh — TextDocumentContentProvider.onDidChange is the native signal VS Code re-queries
  // provideTextDocumentContent on.
  private readonly _onDidChangeTextDocument = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChangeTextDocument.event;

  private readonly sourceControl: vscode.SourceControl;
  private readonly workingTreeGroup: vscode.SourceControlResourceGroup;
  private entries: LedgerStatusEntry[] = [];
  private readonly log: (msg: string) => void;
  // #368 review finding 7: stage/save/revert can fire in quick succession, and two overlapping
  // refresh() calls' own GET /ledger/status responses can resolve out of order — without this, an
  // older, slower response applying *after* a newer, faster one would leave the panel showing
  // stale state. Only the most-recently-started refresh's own result is ever applied.
  private generation = 0;

  constructor(
    private readonly repository: PluginRepository,
    log?: (msg: string) => void,
  ) {
    this.log = log ?? (() => {});
    this.sourceControl = vscode.scm.createSourceControl(LEDGER_SOURCE_CONTROL_ID, LEDGER_SOURCE_CONTROL_LABEL);
    this.workingTreeGroup = this.sourceControl.createResourceGroup(LEDGER_WORKING_TREE_GROUP_ID, LEDGER_WORKING_TREE_GROUP_LABEL);
    this.workingTreeGroup.hideWhenEmpty = true;
  }

  dispose(): void {
    this.sourceControl.dispose();
  }

  /** Empties the working-tree group deterministically — no HTTP call, so no race against the
   *  backend process actually finishing termination. Same reasoning and call site as
   *  `PendingChangeDecorationProvider.clear()` (#331): `exitToLoadout()` calls this, never
   *  `refresh()` — a `refresh()` immediately after `backendManager.stop()` could race the
   *  still-terminating process and read one more momentarily-live response before the connection
   *  actually drops. */
  clear(): void {
    const previousEntries = this.entries;
    this.generation++; // supersede any refresh() still in flight — its result must not land after this
    this.entries = [];
    this.workingTreeGroup.resourceStates = [];
    this._onDidChangeFileDecorations.fire(undefined);
    this.fireCommittedTextChanged(previousEntries, this.entries);
  }

  /** Re-reads `/ledger/status` and rebuilds the working-tree group's resource states. Called from
   *  the same signal every other pending-change-aware provider already refreshes on (#368 AC3) —
   *  never a timer of its own. A failed fetch degrades to an empty group rather than throwing: the
   *  panel going momentarily blank on a backend hiccup is preferable to an unhandled rejection
   *  breaking whichever call site triggered the refresh.
   *
   *  Generation-guarded (review finding 7): stage/save/revert can fire in quick succession, and
   *  two overlapping calls' own GET /ledger/status responses can resolve out of order. Only the
   *  result belonging to the most-recently-started call is ever applied — an older one that
   *  resolves later is silently discarded rather than overwriting newer state. */
  async refresh(): Promise<void> {
    const myGeneration = ++this.generation;
    let nextEntries: LedgerStatusEntry[];
    try {
      nextEntries = await this.repository.getLedgerStatus();
    } catch (e) {
      this.log(`[LedgerScmProvider] getLedgerStatus failed: ${e instanceof Error ? e.message : String(e)}`);
      nextEntries = [];
    }
    if (myGeneration !== this.generation) return; // superseded by a later refresh()/clear() while awaiting

    const previousEntries = this.entries;
    this.entries = nextEntries;
    this.workingTreeGroup.resourceStates = nextEntries.map((entry) => this.toResourceState(entry));
    this._onDidChangeFileDecorations.fire(undefined);
    this.fireCommittedTextChanged(previousEntries, nextEntries);
  }

  // Fires onDidChange for every committed-side URI that changed identity or content across a
  // refresh — the union of what was showing before and what's showing now, not just the new set:
  // a record that dropped out (reverted, or its plugin left the load order) must still invalidate
  // an already-open diff tab's stale content, which provideTextDocumentContent then answers
  // `undefined` for.
  private fireCommittedTextChanged(previous: LedgerStatusEntry[], current: LedgerStatusEntry[]): void {
    const uris = new Map<string, vscode.Uri>();
    for (const entry of [...previous, ...current]) {
      const uri = committedUriFor(entry);
      uris.set(uri.toString(), uri);
    }
    for (const uri of uris.values()) this._onDidChangeTextDocument.fire(uri);
  }

  private toResourceState(entry: LedgerStatusEntry): vscode.SourceControlResourceState {
    return {
      // The real working-tree file (RecordVendor already writes dirt here) — VS Code opens it
      // directly, no synthetic scheme needed for this side of the diff.
      resourceUri: vscode.Uri.file(entry.recordPath),
      command: {
        command: LEDGER_OPEN_DIFF_COMMAND,
        title: 'Open Diff',
        arguments: [entry],
      },
      decorations: { tooltip: resourceTooltipFor(entry) },
    };
  }

  /** Raw text diff only (#368 binding constraint) — committed-vs-dirty, no compare-grid routing
   *  (that's #380). `vscode.diff` is the native two-URI diff-editor command every SCM extension
   *  (including git's own) drives this exact interaction through. */
  async openDiff(entry: LedgerStatusEntry): Promise<void> {
    const title = `${entry.recordType} ${entry.formKey} (Working Tree)`;
    await vscode.commands.executeCommand(
      'vscode.diff', committedUriFor(entry), vscode.Uri.file(entry.recordPath), title);
  }

  provideTextDocumentContent(uri: vscode.Uri): string | undefined {
    const match = this.entries.find((entry) => committedUriFor(entry).toString() === uri.toString());
    return match?.committedText;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') return undefined;
    const entry = this.entries.find((e) => e.recordPath === uri.fsPath);
    if (!entry) return undefined;
    return new vscode.FileDecoration(badgeFor(entry.changeKind), tooltipFor(entry.changeKind));
  }
}
