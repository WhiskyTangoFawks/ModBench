import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { vscode } from './vscode';
import { pickFormKey, pickConditionFunction, confirmRevertGroup, pickScriptName, readClipboardText, openExtendedFieldEditor } from './nativeBridge';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from './messages';

// Issue #212 (refactor): formKeyPickerBridge.ts (#210), conditionFunctionPickerBridge.ts (#211),
// and revertGroupConfirmBridge.ts/addScriptBridge.ts (#212) collapsed into nativeBridge.ts — all
// four shared the same request/reply-correlated-by-requestId mechanism, differing only in which
// message types they used and which field the reply's payload lived under. The shared mechanism
// (resolve-on-match, ignore-a-mismatched-requestId, ignore-unrelated-message-types) is exercised
// once below via pickFormKey as the exemplar — every function goes through the same
// `requestReply` — so each function's own suite only needs to prove its own request shape and
// its own reply's payload field, not the plumbing again.

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
    // but this proves the listener doesn't resolve on requestId alone.
    const resultPromise = pickFormKey('', []);
    const requestId = postedRequestId();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.CONDITION_FUNCTION_PICKED, requestId, functionName: 'wrong-bridge' },
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED, requestId, formKey: 'right-bridge' },
    }));

    expect(await resultPromise).toBe('right-bridge');
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

describe('confirmRevertGroup', () => {
  it('posts OPEN_REVERT_GROUP_CONFIRM with the given detail text', () => {
    void confirmRevertGroup('Npc / 000001:Fallout4.esm · Name');

    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.OPEN_REVERT_GROUP_CONFIRM,
      detail: 'Npc / 000001:Fallout4.esm · Name',
    }));
  });

  it('resolves true when the reply carries confirmed: true', async () => {
    const resultPromise = confirmRevertGroup('detail');
    const requestId = postedRequestId();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.REVERT_GROUP_CONFIRMED, requestId, confirmed: true },
    }));

    expect(await resultPromise).toBe(true);
  });

  it('resolves false when the reply carries confirmed: false (Cancel or Escape/outside click)', async () => {
    const resultPromise = confirmRevertGroup('detail');
    const requestId = postedRequestId();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.REVERT_GROUP_CONFIRMED, requestId, confirmed: false },
    }));

    expect(await resultPromise).toBe(false);
  });
});

describe('pickScriptName', () => {
  it('posts OPEN_ADD_SCRIPT_NAME', () => {
    void pickScriptName();

    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.OPEN_ADD_SCRIPT_NAME,
    }));
  });

  it('resolves the name from the matching reply', async () => {
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
});

// Issue #225: Ctrl+V's clipboard read — unlike copyToClipboard (fire-and-forget, no reply),
// readClipboardText needs the text back, so it goes through the same requestReply shape as the
// bridges above rather than copyToClipboard's own direct-postMessage shape.
describe('readClipboardText', () => {
  it('posts READ_CLIPBOARD', () => {
    void readClipboardText();

    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.READ_CLIPBOARD,
    }));
  });

  it('resolves the clipboard text from the matching reply', async () => {
    const resultPromise = readClipboardText();
    const requestId = postedRequestId();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.CLIPBOARD_READ, requestId, value: 'Dogmeat' },
    }));

    expect(await resultPromise).toBe('Dogmeat');
  });

  it('resolves null when the reply carries value: null (empty clipboard or a failed read)', async () => {
    const resultPromise = readClipboardText();
    const requestId = postedRequestId();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.CLIPBOARD_READ, requestId, value: null },
    }));

    expect(await resultPromise).toBeNull();
  });
});

// Issue #230: unlike every bridge above, openExtendedFieldEditor doesn't return a Promise — the
// editor tab it opens can be saved any number of times before it's closed, so its own map entry
// isn't deleted on the first EXTENDED_EDITOR_COMMITTED the way `pending`'s entries are deleted on
// their first (and only) reply.
describe('openExtendedFieldEditor', () => {
  it('posts OPEN_EXTENDED_EDITOR with the field identity and readOnly flag', () => {
    openExtendedFieldEditor(
      { value: 'a long description', recordLabel: 'Deacon [000123:Fallout4.esm]', fieldName: 'Description', plugin: 'Fallout4.esm', readOnly: false },
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

  it('calls onCommit with each EXTENDED_EDITOR_COMMITTED reply, not just the first', () => {
    const onCommit = vi.fn();
    openExtendedFieldEditor({ value: '', recordLabel: '', fieldName: '', plugin: '', readOnly: false }, onCommit);
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
    openExtendedFieldEditor({ value: '', recordLabel: '', fieldName: '', plugin: '', readOnly: false }, onCommit);
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
    openExtendedFieldEditor({ value: '', recordLabel: '', fieldName: '', plugin: '', readOnly: false }, firstCommit);
    const firstRequestId = postedRequestId();
    openExtendedFieldEditor({ value: '', recordLabel: '', fieldName: '', plugin: '', readOnly: false }, secondCommit);
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
