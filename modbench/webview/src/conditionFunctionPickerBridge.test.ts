import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { vscode } from './vscode';
import { pickConditionFunction } from './conditionFunctionPickerBridge';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from './messages';

// Issue #211: pickConditionFunction is the webview half of the condition-function-picker bridge
// — same shape as pickFormKey (formKeyPickerBridge.ts, #210): the webview cannot call
// vscode.window.showQuickPick itself, so this posts OPEN_CONDITION_FUNCTION_PICKER and awaits the
// extension host's CONDITION_FUNCTION_PICKED reply, correlated by requestId.

function postedRequestId(): string {
  const call = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
  return call.requestId;
}

describe('pickConditionFunction', () => {
  beforeEach(() => {
    vi.mocked(vscode.postMessage).mockClear();
  });

  it('posts OPEN_CONDITION_FUNCTION_PICKER with the seed', () => {
    void pickConditionFunction('GetIsID');

    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.OPEN_CONDITION_FUNCTION_PICKER,
      seed: 'GetIsID',
    }));
  });

  it('resolves with the function name from the matching CONDITION_FUNCTION_PICKED reply', async () => {
    const resultPromise = pickConditionFunction('');
    const requestId = postedRequestId();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.CONDITION_FUNCTION_PICKED, requestId, functionName: 'GetDistance' },
    }));

    expect(await resultPromise).toBe('GetDistance');
  });

  it('resolves with null when the reply carries functionName: null (Escape/blur)', async () => {
    const resultPromise = pickConditionFunction('');
    const requestId = postedRequestId();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.CONDITION_FUNCTION_PICKED, requestId, functionName: null },
    }));

    expect(await resultPromise).toBeNull();
  });

  it('ignores a CONDITION_FUNCTION_PICKED reply for a different requestId', async () => {
    const firstPromise = pickConditionFunction('');
    const firstRequestId = postedRequestId();
    const secondPromise = pickConditionFunction('');
    const secondRequestId = postedRequestId();
    expect(firstRequestId).not.toBe(secondRequestId);

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.CONDITION_FUNCTION_PICKED, requestId: secondRequestId, functionName: 'second' },
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.CONDITION_FUNCTION_PICKED, requestId: firstRequestId, functionName: 'first' },
    }));

    expect(await firstPromise).toBe('first');
    expect(await secondPromise).toBe('second');
  });

  it('ignores unrelated message types', async () => {
    const resultPromise = pickConditionFunction('');
    const requestId = postedRequestId();

    window.dispatchEvent(new MessageEvent('message', { data: { type: 'somethingElse' } }));
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.CONDITION_FUNCTION_PICKED, requestId, functionName: 'X' },
    }));

    expect(await resultPromise).toBe('X');
  });
});
