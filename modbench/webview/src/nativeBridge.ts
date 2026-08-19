import { vscode } from './vscode';
import { WEBVIEW_TO_EXTENSION } from './messages';

// #410/ADR-0041: the request/reply bridge this module used to run — the FormKey QuickPick, the
// condition-function QuickPick, the revert-group modal, the add-script input box, the clipboard
// *read*, and the extended field editor — retired with the write path every one of them fed. What
// survives is the one bridge a viewer needs.

// Issue #224: Ctrl+C's clipboard write — `vscode.env.clipboard.writeText` is extension-host-only
// (webview clipboard access isn't guaranteed), so DiskCell/DiffRow post the already-computed
// model value (modelValue.ts) up here instead. Fire-and-forget: nothing needs to come back, since
// the caller already has the string it copied — there's no answer to wait for, only a write.
export function copyToClipboard(value: string): void {
  vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.COPY_TO_CLIPBOARD, value });
}
