import * as vscode from 'vscode';
import { WEBVIEW_TO_EXTENSION, type WebviewToExtension } from './messages';
import type { Reporter } from '../modmanager/deployer';

export interface RouteRecordPanelMessageDeps {
  // #200: the leveled 'Modbench' channel (#198) the webview has no direct route to — the
  // webview composes the full message text (it has the plugin/field/record identity), this is
  // a pure level→method forward, no VS Code types beyond the injected Pick.
  channel: Pick<vscode.LogOutputChannel, 'debug' | 'info' | 'warn'>;
  // Issue #224: ADR-0026 surfacing for COPY_TO_CLIPBOARD's failure path — a rejected
  // `vscode.env.clipboard.writeText` (headless/remote sessions, missing Linux clipboard tooling,
  // Wayland permissions) is an "explicit action failed" per the severity table (the user pressed
  // Ctrl+C), so it needs an error notification + log, not a silent swallow.
  reporter: Reporter;
}

// Issue #224: Ctrl+C's clipboard write. `vscode.env.clipboard.writeText` is extension-host-only
// (webview clipboard access isn't guaranteed) — the webview has already computed the model value
// (modelValue.ts) by the time this arrives, so there's nothing to inject; this is a direct call,
// same as OPEN_RECORD's `vscode.commands.executeCommand` in routeRecordPanelMessage below, not
// routed through a deps bundle like the *Picker/*Confirm/*Name bridges (which need a per-panel
// reply target this fire-and-forget message has no use for). Split out of
// routeRecordPanelMessage's own dispatch (like routePromptMessage above) partly to keep that
// function's complexity down, and partly because the try/catch reads better as its own named
// step: this message is itself called fire-and-forget (`void routeRecordPanelMessage(...)` at the
// onDidReceiveMessage call site), so an unhandled rejection here would surface as nothing at all,
// not even a silent swallow — a real failure mode for a clipboard write (headless/remote sessions,
// missing Linux clipboard tooling, Wayland permissions), so it gets the same catch-log-surface
// treatment every other catch in this codebase uses (modbench/CLAUDE.md: "no silent catch {}").
async function copyToClipboard(reporter: Reporter, value: string): Promise<void> {
  try {
    await vscode.env.clipboard.writeText(value);
  } catch (err) {
    reporter.report('error', 'Could not copy to the clipboard.', err instanceof Error ? err.message : String(err));
  }
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
  } else if (m.type === WEBVIEW_TO_EXTENSION.LOG) {
    deps.channel[m.level](m.message);
  } else if (m.type === WEBVIEW_TO_EXTENSION.COPY_TO_CLIPBOARD) {
    await copyToClipboard(deps.reporter, m.value);
  }
}
