// mods-fomod.md, Opening: the FOMOD installer's page, a tab that opens when the installer first has a state to show.

import * as vscode from 'vscode';
import type { FomodDialog } from '../modCommands/modCommands';
import { showWebviewPage } from '../drivingLib/webviewPage';
import type { AskQuestion } from '../ports/dialog';
import type { Progress } from '../drivingLib/pausableProgress';
import { FOMOD_STATE, isFomodReady, parseFomodMove, withImages, type FomodMove, type FomodState, type ReleaseImage } from '../wire/fomodPage';
import { WEBVIEW_SCRIPTS } from '../wire/webviewPages';

const INSTALL_ANYWAY = 'Install anyway';

/** A page for one install. Closing its tab is Cancel. */
export function fomodDialog(extensionUri: vscode.Uri, ask: AskQuestion, progress: Progress): FomodDialog {
  let panel: vscode.WebviewPanel | undefined;
  let moved: (move: FomodMove) => void = () => undefined;
  let latest: FomodState<ReleaseImage> | undefined;
  let closing = false;

  let release: vscode.Uri | undefined;

  // The state's images are paths in the release's folder; the page loads each from the webview's URI for it.
  const post = (): void => {
    if (panel === undefined || latest === undefined || release === undefined) return;
    const { webview } = panel;
    const folder = release;
    const state = withImages(latest, (image) => (image === undefined ? '' : webview.asWebviewUri(vscode.Uri.joinPath(folder, ...image.path.split('/'))).toString()));
    void webview.postMessage({ type: FOMOD_STATE, state });
  };

  const open = (module: string, imagesFolder: vscode.Uri): vscode.WebviewPanel => {
    const opened = vscode.window.createWebviewPanel('modbench.fomod', `FOMOD: ${module}`, vscode.ViewColumn.Active, { retainContextWhenHidden: true });
    opened.onDidDispose(() => {
      if (!closing) moved({ kind: 'cancel' });
    });
    opened.webview.onDidReceiveMessage((message: unknown) => {
      const move = parseFomodMove(message);
      if (move !== undefined) moved(move);
      else if (isFomodReady(message)) post();
    });
    showWebviewPage(opened.webview, extensionUri, { script: WEBVIEW_SCRIPTS.FOMOD, imagesFolder });
    return opened;
  };

  return {
    show: (state, folder) => {
      latest = state;
      release ??= vscode.Uri.file(folder);
      panel ??= open(state.module, release);
      post();
    },
    onMove: (handler) => {
      moved = handler;
    },
    confirmMissing: async (missing) => await ask(
      'This FOMOD names files its archive does not hold.', { modal: true, detail: missing.join('\n') }, INSTALL_ANYWAY) === INSTALL_ANYWAY,
    asking: (asking) => {
      if (asking) progress.waiting();
      else progress.working();
    },
    close: () => {
      closing = true;
      panel?.dispose();
    },
  };
}
