import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { vscode } from './vscode';
import { confirmRevertGroup } from './revertGroupConfirmBridge';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from './messages';

// Issue #212: confirmRevertGroup is the webview half of the revert-group-confirmation bridge —
// the webview cannot call vscode.window.showWarningMessage itself, so this posts
// OPEN_REVERT_GROUP_CONFIRM and awaits the extension host's REVERT_GROUP_CONFIRMED reply,
// correlated by requestId (same shape as formKeyPickerBridge.ts/conditionFunctionPickerBridge.ts).

function postedRequestId(): string {
  const call = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
  return call.requestId;
}

describe('confirmRevertGroup', () => {
  beforeEach(() => {
    vi.mocked(vscode.postMessage).mockClear();
  });

  it('posts OPEN_REVERT_GROUP_CONFIRM with the given detail text', () => {
    void confirmRevertGroup('Npc / 000001:Fallout4.esm · Name');

    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.OPEN_REVERT_GROUP_CONFIRM,
      detail: 'Npc / 000001:Fallout4.esm · Name',
    }));
  });

  it('resolves true from a matching REVERT_GROUP_CONFIRMED reply with confirmed: true', async () => {
    const resultPromise = confirmRevertGroup('detail');
    const requestId = postedRequestId();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.REVERT_GROUP_CONFIRMED, requestId, confirmed: true },
    }));

    expect(await resultPromise).toBe(true);
  });

  it('resolves false from a matching REVERT_GROUP_CONFIRMED reply with confirmed: false', async () => {
    const resultPromise = confirmRevertGroup('detail');
    const requestId = postedRequestId();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.REVERT_GROUP_CONFIRMED, requestId, confirmed: false },
    }));

    expect(await resultPromise).toBe(false);
  });

  it('ignores a REVERT_GROUP_CONFIRMED reply for a different requestId', async () => {
    const firstPromise = confirmRevertGroup('a');
    const firstRequestId = postedRequestId();
    const secondPromise = confirmRevertGroup('b');
    const secondRequestId = postedRequestId();
    expect(firstRequestId).not.toBe(secondRequestId);

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.REVERT_GROUP_CONFIRMED, requestId: secondRequestId, confirmed: false },
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.REVERT_GROUP_CONFIRMED, requestId: firstRequestId, confirmed: true },
    }));

    expect(await firstPromise).toBe(true);
    expect(await secondPromise).toBe(false);
  });

  it('ignores unrelated message types', async () => {
    const resultPromise = confirmRevertGroup('detail');
    const requestId = postedRequestId();

    window.dispatchEvent(new MessageEvent('message', { data: { type: 'somethingElse' } }));
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.REVERT_GROUP_CONFIRMED, requestId, confirmed: true },
    }));

    expect(await resultPromise).toBe(true);
  });
});
