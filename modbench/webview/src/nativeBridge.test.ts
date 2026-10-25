import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { vscode } from './vscode';
import { listen, pickFormKey, requestRecordLoad } from './nativeBridge';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from '../../src/wire/messages';

function postedRequestId(type: typeof WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER | typeof WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD): string {
  const call = vi.mocked(vscode.postMessage).mock.calls.at(-1)?.[0];
  if (call?.type !== type) throw new Error(`Expected a ${type} post`);
  return call.requestId;
}

beforeEach(() => {
  vi.mocked(vscode.postMessage).mockClear();
});

describe('a request to the host resolves from its own reply alone', () => {
  it('resolves from the matching reply, correlated by requestId — a concurrent call is untouched', async () => {
    const firstPromise = pickFormKey('', []);
    const firstRequestId = postedRequestId(WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER);
    const secondPromise = pickFormKey('', []);
    const secondRequestId = postedRequestId(WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER);
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
    const requestId = postedRequestId(WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER);

    window.dispatchEvent(new MessageEvent('message', { data: { type: 'somethingElse' } }));
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED, requestId, formKey: 'X' },
    }));

    expect(await resultPromise).toBe('X');
  });

  it('ignores a reply for the right requestId but the wrong reply type', async () => {
    const resultPromise = pickFormKey('', []);
    const requestId = postedRequestId(WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER);

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, requestId, formKey: 'wrong-type' },
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED, requestId, formKey: 'right-type' },
    }));

    expect(await resultPromise).toBe('right-type');
  });
});

describe('the FormKey picker, asked of the host', () => {
  it('is asked with the seed and the valid record types', () => {
    void pickFormKey('000019:Fallout4.esm', ['race']);

    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER,
      seed: '000019:Fallout4.esm',
      validTypes: ['race'],
    }));
  });

  it('resolves no FormKey when it is dismissed', async () => {
    const resultPromise = pickFormKey('', []);
    const requestId = postedRequestId(WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER);

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED, requestId, formKey: null },
    }));

    expect(await resultPromise).toBeNull();
  });
});

describe('a record\'s read, asked of the host', () => {
  it('is asked with the formKey and the columns', () => {
    const columns = [{ formKey: '000002:B.esp', plugin: { name: 'B.esp', origin: 'ModB' } }];
    void requestRecordLoad('000001:A.esp', columns);

    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD, formKey: '000001:A.esp', columns,
    }));
  });

  it('resolves a refused answer as its failure', async () => {
    const resultPromise = requestRecordLoad('000001:A.esp', []);
    const requestId = postedRequestId(WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD);

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId, ok: false, failure: { failed: 'refused', refusal: 'No such record.' } },
    }));

    expect(await resultPromise).toEqual({ ok: false, failure: { failed: 'refused', refusal: 'No such record.' } });
  });
});

describe('the page\'s one receive loop', () => {
  it('hands the host\'s messages to a listener, parsed, once each, and not after it stops', () => {
    const heard: unknown[] = [];
    const stop = listen((msg) => heard.push(msg));
    const pasted = { type: EXTENSION_TO_WEBVIEW.PASTE_INTO_CELL, text: 'x' };

    window.dispatchEvent(new MessageEvent('message', { data: { type: 'somethingElse' } }));
    window.dispatchEvent(new MessageEvent('message', { data: pasted }));
    stop();
    window.dispatchEvent(new MessageEvent('message', { data: pasted }));

    expect(heard).toEqual([pasted]);
  });
});
