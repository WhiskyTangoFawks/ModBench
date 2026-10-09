import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { vscode } from './vscode';
import { listen, pickFormKey, requestRecordLoad } from './nativeBridge';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from '../../src/wire/messages';

function postedRequestId(): string {
  const call = vi.mocked(vscode.postMessage).mock.calls.at(-1)?.[0];
  if (call === undefined || call.type !== WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER) {
    throw new Error('Expected an OPEN_FORM_KEY_PICKER post');
  }
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
    const resultPromise = pickFormKey('', []);
    const requestId = postedRequestId();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, requestId, formKey: 'wrong-type' },
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

describe('requestRecordLoad, whose request shape and reply unwrapping are its own', () => {
  function postedFormKeyRequestId(): string {
    const call = vi.mocked(vscode.postMessage).mock.calls.at(-1)?.[0];
    if (call === undefined || call.type !== WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD) {
      throw new Error('Expected a REQUEST_RECORD_LOAD post');
    }
    return call.requestId;
  }

  it('posts REQUEST_RECORD_LOAD with the formKey and the columns', () => {
    const columns = [{ formKey: '000002:B.esp', plugin: { name: 'B.esp', origin: 'ModB' } }];
    void requestRecordLoad('000001:A.esp', columns);

    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD, formKey: '000001:A.esp', columns,
    }));
  });

  it('resolves the host\'s answer untransformed', async () => {
    const resultPromise = requestRecordLoad('000001:A.esp', []);
    const requestId = postedFormKeyRequestId();

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
