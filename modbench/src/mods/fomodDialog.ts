// mods-fomod.md, Opening: the FOMOD installer's page, a tab that opens when the installer first has a state to show.

import * as vscode from 'vscode';
import type { FomodDialog } from '../instanceAdapter/instanceAdapter';
import { showWebviewPage } from '../drivingLib/webviewPage';
import type { AskQuestion } from '../ports/dialog';
import { FOMOD_STATE, isFomodReady, parseFomodMove, type FomodMove, type FomodState } from '../wire/fomodPage';
import { WEBVIEW_SCRIPTS } from '../wire/webviewPages';

const INSTALL_ANYWAY = 'Install anyway';

/** A page for one install. Closing its tab is Cancel. */
export function fomodDialog(extensionUri: vscode.Uri, ask: AskQuestion): FomodDialog {
  let panel: vscode.WebviewPanel | undefined;
  let moved: (move: FomodMove) => void = () => undefined;
  let latest: FomodState | undefined;
  let closing = false;

  const post = (): void => {
    if (panel !== undefined && latest !== undefined) void panel.webview.postMessage({ type: FOMOD_STATE, state: latest });
  };

  const open = (module: string): vscode.WebviewPanel => {
    const opened = vscode.window.createWebviewPanel('modbench.fomod', `FOMOD: ${module}`, vscode.ViewColumn.Active, { retainContextWhenHidden: true });
    opened.onDidDispose(() => {
      if (!closing) moved({ kind: 'cancel' });
    });
    opened.webview.onDidReceiveMessage((message: unknown) => {
      const move = parseFomodMove(message);
      if (move !== undefined) moved(move);
      else if (isFomodReady(message)) post();
    });
    showWebviewPage(opened.webview, extensionUri, { script: WEBVIEW_SCRIPTS.FOMOD });
    return opened;
  };

  return {
    show: (state) => {
      latest = state;
      panel ??= open(state.module);
      post();
    },
    onMove: (handler) => {
      moved = handler;
    },
    confirmMissing: async (missing) => await ask(
      'This FOMOD names files its archive does not hold.', { modal: true, detail: missing.join('\n') }, INSTALL_ANYWAY) === INSTALL_ANYWAY,
    close: () => {
      closing = true;
      panel?.dispose();
    },
  };
}
