import { vscode } from './vscode';
import { WEBVIEW_TO_EXTENSION } from './messages';

// #410/ADR-0041: the request/reply bridge this module used to run — the FormKey QuickPick, the
// condition-function QuickPick, the revert-group modal, the add-script input box, the clipboard
// *read*, and the extended field editor — retired with the write path every one of them fed. #415
// adds back exactly one poster, for the one gesture it restores; the rest travel with the
// gesture-inventory ticket that owns them.

// Issue #224: Ctrl+C's clipboard write — `vscode.env.clipboard.writeText` is extension-host-only
// (webview clipboard access isn't guaranteed), so DiskCell/DiffRow post the already-computed
// model value (modelValue.ts) up here instead. Fire-and-forget: nothing needs to come back, since
// the caller already has the string it copied — there's no answer to wait for, only a write.
export function copyToClipboard(value: string): void {
  vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.COPY_TO_CLIPBOARD, value });
}

// #415/ADR-0041: one field edit, on its way to the single write path. Fire-and-forget in the same
// sense COPY_TO_CLIPBOARD is — the panel does not await a value back, because the answer to "what
// does the record say now" is a re-read (RECORD_EDITED), never this call's return. A refusal
// surfaces as a native notification from the host, which is why this goes through the bridge at all
// rather than posting to the backend from here the way every read does.
export function editField(
  formKey: string, plugin: string, origin: string, fieldPath: string, value: unknown,
): void {
  vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.EDIT_FIELD, formKey, plugin, origin, fieldPath, value });
}
