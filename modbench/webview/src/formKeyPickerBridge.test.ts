import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { vscode } from './vscode';
import { pickFormKey } from './formKeyPickerBridge';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from './messages';

// Issue #210: pickFormKey is the webview half of the FormKey-picker bridge — the webview cannot
// call vscode.window.createQuickPick itself, so this posts OPEN_FORM_KEY_PICKER and awaits the
// extension host's FORM_KEY_PICKED reply, correlated by requestId (every FormKeyCell/
// VmadObjectEditor/AddPropertyDialog call site uses this in place of the deleted inline
// <FormKeyPicker>).

function postedRequestId(): string {
  const call = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
  return call.requestId;
}

describe('pickFormKey', () => {
  beforeEach(() => {
    vi.mocked(vscode.postMessage).mockClear();
  });

  it('posts OPEN_FORM_KEY_PICKER with the seed and validTypes', () => {
    void pickFormKey('000019:Fallout4.esm', ['race']);

    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER,
      seed: '000019:Fallout4.esm',
      validTypes: ['race'],
    }));
  });

  it('resolves with the FormKey from the matching FORM_KEY_PICKED reply', async () => {
    const resultPromise = pickFormKey('', []);
    const requestId = postedRequestId();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED, requestId, formKey: '00001A:Fallout4.esm' },
    }));

    expect(await resultPromise).toBe('00001A:Fallout4.esm');
  });

  it('resolves with null when the reply carries formKey: null (Escape/blur)', async () => {
    const resultPromise = pickFormKey('', []);
    const requestId = postedRequestId();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED, requestId, formKey: null },
    }));

    expect(await resultPromise).toBeNull();
  });

  it('ignores a FORM_KEY_PICKED reply for a different requestId', async () => {
    const firstPromise = pickFormKey('', []);
    const firstRequestId = postedRequestId();
    const secondPromise = pickFormKey('', []);
    const secondRequestId = postedRequestId();
    expect(firstRequestId).not.toBe(secondRequestId);

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED, requestId: secondRequestId, formKey: 'second' },
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED, requestId: firstRequestId, formKey: 'first' },
    }));

    expect(await firstPromise).toBe('first');
    expect(await secondPromise).toBe('second');
  });

  it('ignores unrelated message types', async () => {
    const resultPromise = pickFormKey('', []);
    const requestId = postedRequestId();

    window.dispatchEvent(new MessageEvent('message', { data: { type: 'somethingElse' } }));
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED, requestId, formKey: 'X' },
    }));

    expect(await resultPromise).toBe('X');
  });
});
