import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { vscode } from './vscode';
import { pickFormKey, pickConditionFunction, openExtendedFieldEditor } from './nativeBridge';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from './messages';

// pickFormKey's suite exercises the shared requestReply plumbing (resolve-on-match,
// ignore-a-mismatched-requestId, ignore-unrelated-message-types) once, as the exemplar for the
// near-identical bridges. Further native-prompt bridges (the condition-function picker, etc.)
// extend this file rather than re-proving the shared mechanism.

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

describe('pickConditionFunction', () => {
  it('posts OPEN_CONDITION_FUNCTION_PICKER with the seed', () => {
    void pickConditionFunction('GetIsID');

    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.OPEN_CONDITION_FUNCTION_PICKER,
      seed: 'GetIsID',
    }));
  });

  it('resolves the function name from the matching reply', async () => {
    const resultPromise = pickConditionFunction('');
    const requestId = postedRequestId();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.CONDITION_FUNCTION_PICKED, requestId, functionName: 'GetDistance' },
    }));

    expect(await resultPromise).toBe('GetDistance');
  });

  it('resolves null when the reply carries functionName: null (Escape/blur)', async () => {
    const resultPromise = pickConditionFunction('');
    const requestId = postedRequestId();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.CONDITION_FUNCTION_PICKED, requestId, functionName: null },
    }));

    expect(await resultPromise).toBeNull();
  });
});

// Unlike pickFormKey above, openExtendedFieldEditor doesn't return a
// Promise — the editor tab it opens can be saved any number of times before it's closed, so its
// own map entry isn't deleted on the first EXTENDED_EDITOR_COMMITTED the way `inFlight`'s entries
// are deleted on their first (and only) reply.
describe('openExtendedFieldEditor', () => {
  it('posts OPEN_EXTENDED_EDITOR with the field identity and readOnly flag', () => {
    openExtendedFieldEditor(
      { value: 'a long description', recordLabel: 'Deacon [000123:Fallout4.esm]', fieldName: 'Description', plugin: 'Fallout4.esm', origin: 'Data', readOnly: false },
      vi.fn(),
    );

    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.OPEN_EXTENDED_EDITOR,
      value: 'a long description',
      recordLabel: 'Deacon [000123:Fallout4.esm]',
      fieldName: 'Description',
      plugin: 'Fallout4.esm',
      readOnly: false,
    }));
  });

  // ADR-0036: origin is forwarded even though the temp-file path doesn't use it yet.
  it('posts OPEN_EXTENDED_EDITOR with origin', () => {
    openExtendedFieldEditor(
      { value: 'x', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Shared.esp', origin: 'ModB', readOnly: false },
      vi.fn(),
    );

    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({ plugin: 'Shared.esp', origin: 'ModB' }));
  });

  it('calls onCommit with each EXTENDED_EDITOR_COMMITTED reply, not just the first', () => {
    const onCommit = vi.fn();
    openExtendedFieldEditor({ value: '', recordLabel: '', fieldName: '', plugin: '', origin: 'Data', readOnly: false }, onCommit);
    const requestId = postedRequestId();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_COMMITTED, requestId, value: 'first save' },
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_COMMITTED, requestId, value: 'second save' },
    }));

    expect(onCommit).toHaveBeenNthCalledWith(1, 'first save');
    expect(onCommit).toHaveBeenNthCalledWith(2, 'second save');
  });

  it('stops calling onCommit once EXTENDED_EDITOR_CLOSED arrives for that requestId', () => {
    const onCommit = vi.fn();
    openExtendedFieldEditor({ value: '', recordLabel: '', fieldName: '', plugin: '', origin: 'Data', readOnly: false }, onCommit);
    const requestId = postedRequestId();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_CLOSED, requestId },
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_COMMITTED, requestId, value: 'too late' },
    }));

    expect(onCommit).not.toHaveBeenCalled();
  });

  it('a concurrent open for a different requestId is unaffected by one being closed', () => {
    const firstCommit = vi.fn();
    const secondCommit = vi.fn();
    openExtendedFieldEditor({ value: '', recordLabel: '', fieldName: '', plugin: '', origin: 'Data', readOnly: false }, firstCommit);
    const firstRequestId = postedRequestId();
    openExtendedFieldEditor({ value: '', recordLabel: '', fieldName: '', plugin: '', origin: 'Data', readOnly: false }, secondCommit);
    const secondRequestId = postedRequestId();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_CLOSED, requestId: firstRequestId },
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_COMMITTED, requestId: secondRequestId, value: 'still open' },
    }));

    expect(firstCommit).not.toHaveBeenCalled();
    expect(secondCommit).toHaveBeenCalledWith('still open');
  });
});
