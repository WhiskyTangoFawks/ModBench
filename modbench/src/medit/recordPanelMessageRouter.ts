import * as vscode from 'vscode';
import { WEBVIEW_TO_EXTENSION, type WebviewToExtension } from './messages';
import type { PendingChangesTreeProvider, PendingTreeNode } from './PendingChangesTreeProvider';
import type { Reporter } from '../modmanager/deployer';

// Issue #140: reveal deps bundled into one optional param so a record panel not wired for
// reveal (there is exactly one, but keeping the seam explicit) still compiles — and so
// openRecordPanel's own parameter count doesn't grow every time the panel needs one more
// thing from the extension host.
export interface RevealDeps {
  provider: PendingChangesTreeProvider;
  view: vscode.TreeView<PendingTreeNode>;
  log: (msg: string) => void;
  reporter: Reporter;
}

// Issue #140: resolves a pending change id to a tree node and reveals it, expanding a
// multi-member group's parent and showing the tree if it was collapsed or not visible
// (`focus: true`). No record semantics live here — resolution is the provider's job
// (`resolveChange`), this is purely the VS Code plumbing the webview can't do itself. A
// change that is no longer pending (already saved or reverted) resolves to `undefined` and
// is logged, not thrown (ADR-0026-style: recoverable, not a toast).
async function revealPendingChange(changeId: string, deps: RevealDeps | undefined): Promise<void> {
  if (!deps) return;
  try {
    const node = await deps.provider.resolveChange(changeId);
    if (!node) {
      deps.log(`[revealPendingChange] change ${changeId} is no longer pending (saved or reverted)`);
      return;
    }
    await deps.view.reveal(node, { select: true, focus: true, expand: true });
  } catch (err) {
    // An explicit user action failed (they clicked the cell), so ADR-0026 wants a notification,
    // not a silent log — unlike the no-longer-pending branch above, which is recoverable.
    deps.reporter.report('error', 'Could not reveal that pending change.', err instanceof Error ? err.message : String(err));
  }
}

export interface RouteRecordPanelMessageDeps {
  reveal: RevealDeps | undefined;
  // #200: the leveled 'Modbench' channel (#198) the webview has no direct route to — the
  // webview composes the full message text (it has the plugin/field/record identity), this is
  // a pure level→method forward, no VS Code types beyond the injected Pick.
  channel: Pick<vscode.LogOutputChannel, 'debug' | 'info' | 'warn'>;
}

// Issue #174: the record editor webview and the extension host are different processes,
// bridged only by `postMessage` — this is the single dispatch point for every message the
// webview sends up. Kept as a plain function (not a class/registered-handler pattern) so it's
// callable directly from a unit test without a VS Code test harness: only `vscode.commands
// .executeCommand` needs mocking, everything else is a plain-object dep.
export async function routeRecordPanelMessage(msg: unknown, deps: RouteRecordPanelMessageDeps): Promise<void> {
  if (typeof msg !== 'object' || msg === null || !('type' in msg)) return;
  const m = msg as WebviewToExtension;
  if (m.type === WEBVIEW_TO_EXTENSION.OPEN_RECORD) {
    await vscode.commands.executeCommand('modbench.openEditor', { formKey: m.formKey, label: m.formKey });
  } else if (m.type === WEBVIEW_TO_EXTENSION.REVEAL_PENDING_CHANGE) {
    await revealPendingChange(m.changeId, deps.reveal);
  } else if (m.type === WEBVIEW_TO_EXTENSION.PENDING_CHANGED) {
    deps.reveal?.provider.refresh();
  } else if (m.type === WEBVIEW_TO_EXTENSION.LOG) {
    deps.channel[m.level](m.message);
  }
}
