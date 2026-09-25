import type * as vscode from 'vscode';
import { EXTENSION_TO_WEBVIEW, type ExtensionToWebview } from '../wire/messages';

/** The tab an edit of the FormID came from goes with the record to its new FormKey and reads it
 *  there. mEdit's report may land before this answer, so the read cannot wait for it. */
export function followRecordInPanel<Panel extends { title: string; webview: Pick<vscode.Webview, 'postMessage'> }>(
  panel: Panel,
  activeRecordTracker: { formKeyOf(panel: Panel): string | undefined; setFormKey(panel: Panel, formKey: string): void },
  formKey: string,
  newFormKey: string,
): void {
  if (activeRecordTracker.formKeyOf(panel) !== formKey) return;
  activeRecordTracker.setFormKey(panel, newFormKey);
  if (panel.title === formKey) panel.title = newFormKey;
  void panel.webview.postMessage({ type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey: newFormKey } satisfies ExtensionToWebview);
}
