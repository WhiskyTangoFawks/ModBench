import type * as vscode from 'vscode';
import type { PluginTreeProvider } from './PluginTreeProvider';
import type { RecordDecorationProvider } from './RecordDecorationProvider';
import { recordResourceUri } from './recordResourceUri';
import { EXTENSION_TO_WEBVIEW, type ExtensionToWebview } from './messages';

/** Broadcasts one message to every open record panel (`'modbench'`-viewType) — used for the M/A
 *  badge's own record-edited notice here, and by several other extension.ts call sites for their
 *  own load-order-wide notices (conflicts computed, filter changed, …). Kept alongside
 *  {@link makeOnRecordEdited} purely because that is its own only caller in this file; every other
 *  caller stays in `extension.ts` where the shared `recordPanels` set lives. */
export function broadcastToRecordPanels(recordPanels: Set<vscode.WebviewPanel>, msg: ExtensionToWebview): void {
  for (const panel of recordPanels) void panel.webview.postMessage(msg);
}

/** Builds the `onRecordEdited` callback — its own file so the
 *  wiring a real field edit drives is directly unit-testable without importing the whole of
 *  `extension.ts`, the same reason `compileTarget.ts`/`loadOrderProgress.ts`/`crashRepairOffer.ts`/
 *  `copyTargetPlugins.ts`/`trackProgress.ts` are each their own file rather than inline there.
 *  Scoped, not `refresh()`: patches the one cached record
 *  `PluginTreeProvider` already holds and refreshes only that record's own decoration, so a
 *  committed cell edit never pays a page-cache invalidation + repository refetch. Hardcodes
 *  `'Modified'`: the edit response carries no resulting `WorkingTreeState`, so the one case this
 *  can't see is an edit that converges back to the committed bytes (revert-by-typing
 *  convergence) — that row shows a stale M until an unrelated refresh corrects it, no worse than
 *  every other fact this cache already tolerates going stale between refreshes (the same
 *  no-watcher posture).
 *
 *  `refreshCompileStale`: injected rather than calling `extension.ts`'s own
 *  module-private `refreshMatchingPlugins` directly — the same shape
 *  `LoadOrderControllerDeps.refreshMatchingPlugins` already uses, and what keeps this file free of
 *  any dependency on `extension.ts`'s module-level state, which is what makes it importable in
 *  isolation at all. Called unconditionally, not gated on `markWorkingTreeState`'s own cache-hit:
 *  the edit already landed server-side by the time this fires, so the plugin row's compile-staleness
 *  decoration needs the same re-derive regardless of whether the record-row cache had this
 *  FormKey.
 *
 *  `refreshSourceControl`: same injected-callback shape as `refreshCompileStale`, for the
 *  same reason — this is what makes VS Code's native Source Control panel pick up the resulting
 *  working-tree change without a manual Refresh click. Also called unconditionally: the edit
 *  landed server-side regardless of whether this record-row cache had a hit, so the SCM refresh
 *  can't be gated on that either. `extension.ts` supplies a lookup from the edited plugin's own
 *  filename to the `vscode.git` `Repository` handle `trackedRepositories.ts`'s
 *  `registerTrackedRepositories` opened for its mod folder, and prompts that repository's own
 *  `status()`. */
export function makeOnRecordEdited(
  treeProvider: PluginTreeProvider,
  recordDecorationProvider: RecordDecorationProvider,
  recordPanels: Set<vscode.WebviewPanel>,
  refreshCompileStale: () => void,
  refreshSourceControl: (plugin: string) => void,
): (formKey: string, plugin: string, origin: string) => void {
  return (formKey, plugin, origin) => {
    broadcastToRecordPanels(recordPanels, { type: EXTENSION_TO_WEBVIEW.RECORD_EDITED, formKey });
    if (treeProvider.markWorkingTreeState(plugin, origin, formKey, 'Modified')) {
      // The M/A badge is location-independent (a local edit is a fact about
      // the record, not about where it's viewed), but the badge-scoping fix gave the Conflicts
      // node's own row a distinct resourceUri from the ordinary one — refresh both, so a record
      // visible in both places at once gets its M/A badge updated in both.
      recordDecorationProvider.refresh(recordResourceUri(plugin, origin, formKey));
      recordDecorationProvider.refresh(recordResourceUri(plugin, origin, formKey, true));
    }
    refreshCompileStale();
    refreshSourceControl(plugin);
  };
}
