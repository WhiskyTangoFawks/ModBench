import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { vscode } from './vscode';
import { pickScriptName } from './addScriptBridge';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from './messages';

// Issue #212: pickScriptName is the webview half of the add-script bridge — the webview cannot
// call vscode.window.showInputBox itself, so this posts OPEN_ADD_SCRIPT_NAME and awaits the
// extension host's ADD_SCRIPT_NAME_PICKED reply, correlated by requestId (same shape as
// formKeyPickerBridge.ts/conditionFunctionPickerBridge.ts/revertGroupConfirmBridge.ts).

function postedRequestId(): string {
  const call = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
  return call.requestId;
}

describe('pickScriptName', () => {
  beforeEach(() => {
    vi.mocked(vscode.postMessage).mockClear();
  });

  it('posts OPEN_ADD_SCRIPT_NAME', () => {
    void pickScriptName();

    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.OPEN_ADD_SCRIPT_NAME,
    }));
  });

  it('resolves with the name from the matching ADD_SCRIPT_NAME_PICKED reply', async () => {
    const resultPromise = pickScriptName();
    const requestId = postedRequestId();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.ADD_SCRIPT_NAME_PICKED, requestId, name: 'MyScript' },
    }));

    expect(await resultPromise).toBe('MyScript');
  });

  it('resolves null when the reply carries name: null (Escape/blur)', async () => {
    const resultPromise = pickScriptName();
    const requestId = postedRequestId();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.ADD_SCRIPT_NAME_PICKED, requestId, name: null },
    }));

    expect(await resultPromise).toBeNull();
  });

  it('ignores an ADD_SCRIPT_NAME_PICKED reply for a different requestId', async () => {
    const firstPromise = pickScriptName();
    const firstRequestId = postedRequestId();
    const secondPromise = pickScriptName();
    const secondRequestId = postedRequestId();
    expect(firstRequestId).not.toBe(secondRequestId);

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.ADD_SCRIPT_NAME_PICKED, requestId: secondRequestId, name: 'second' },
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.ADD_SCRIPT_NAME_PICKED, requestId: firstRequestId, name: 'first' },
    }));

    expect(await firstPromise).toBe('first');
    expect(await secondPromise).toBe('second');
  });

  it('ignores unrelated message types', async () => {
    const resultPromise = pickScriptName();
    const requestId = postedRequestId();

    window.dispatchEvent(new MessageEvent('message', { data: { type: 'somethingElse' } }));
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.ADD_SCRIPT_NAME_PICKED, requestId, name: 'X' },
    }));

    expect(await resultPromise).toBe('X');
  });
});
