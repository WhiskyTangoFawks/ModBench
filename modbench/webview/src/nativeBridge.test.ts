import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { vscode } from './vscode';
import { pickFormKey } from './nativeBridge';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from './messages';

// #426: restores the request/reply bridge mechanism #410 retired along with the pending-change
// write path it fed (nativeBridge.ts's own doc comment) — the FormKey picker is the first gesture
// back on it, so its own suite exercises the shared requestReply plumbing (resolve-on-match,
// ignore-a-mismatched-requestId, ignore-unrelated-message-types) once, the same way the pre-#410
// suite used pickFormKey as its exemplar for four near-identical bridges. Later tickets restoring
// further native-prompt bridges (the condition-function picker, etc.) extend this file rather than
// re-proving the shared mechanism.

function postedRequestId(): string {
  const call = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
  return call.requestId;
}

beforeEach(() => {
  vi.mocked(vscode.postMessage).mockClear();
});

describe('nativeBridge shared request/reply mechanism (exercised via pickFormKey)', () => {
  it('resolves from the matching reply, correlated by requestId — a concurrent call is untouched', async () => {
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

  it('ignores a reply for the right requestId but the wrong reply type', async () => {
    // Guards the replyType check inside the shared listener — a requestId collision across two
    // different bridges should never happen in practice (the counter is global to the module),
    // but this proves the listener doesn't resolve on requestId alone. Stands in with
    // RECORD_EDITED as "some other reply type carrying this same requestId shape", since a second
    // request/reply bridge doesn't exist on this door yet.
    const resultPromise = pickFormKey('', []);
    const requestId = postedRequestId();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.RECORD_EDITED, requestId, formKey: 'wrong-type' },
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED, requestId, formKey: 'right-type' },
    }));

    expect(await resultPromise).toBe('right-type');
  });
});

describe('pickFormKey', () => {
  it('posts OPEN_FORM_KEY_PICKER with the seed and validTypes', () => {
    void pickFormKey('000019:Fallout4.esm', ['race']);

    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER,
      seed: '000019:Fallout4.esm',
      validTypes: ['race'],
    }));
  });

  it('resolves null when the reply carries formKey: null (Escape/blur)', async () => {
    const resultPromise = pickFormKey('', []);
    const requestId = postedRequestId();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED, requestId, formKey: null },
    }));

    expect(await resultPromise).toBeNull();
  });
});
