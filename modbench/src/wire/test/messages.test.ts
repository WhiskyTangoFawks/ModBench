import { describe, it, expect } from 'vitest';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, parseWebviewToExtension, parseExtensionToWebview } from '../messages';

describe('the focused cell message that tells the host which cell a palette field gesture acts on, as the context its menu would hand the command', () => {
  it('carries the focused cell\'s context, or null when no cell is focused', () => {
    const context = { webviewSection: 'arrayElement', formKey: '000001:A.esp', path: [] };
    expect(parseWebviewToExtension({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context, entered: true }))
      .toEqual({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context, entered: true });
    expect(parseWebviewToExtension({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: null, entered: false }))
      .toEqual({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: null, entered: false });
  });

  it('is refused when its context is neither an object nor null', () => {
    expect(() => parseWebviewToExtension({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: 'arrayElement', entered: true })).toThrow();
  });

  it('is refused without saying whether the user entered the cell', () => {
    expect(() => parseWebviewToExtension({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: null })).toThrow();
  });
});

describe('the record load request the webview asks of the host, because nothing outside the client names the port, and its answer', () => {
  it('carries the formKey, the columns the tab shows beside it and the requestId that pairs the reply', () => {
    const columns = [{ formKey: '000002:B.esp', plugin: { name: 'B.esp', origin: 'ModB' } }];
    expect(parseWebviewToExtension({ type: WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD, requestId: 'r1', formKey: '000001:A.esp', columns }))
      .toEqual({ type: WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD, requestId: 'r1', formKey: '000001:A.esp', columns });
  });

  it('rejects a request whose column names no plugin whole', () => {
    expect(() => parseWebviewToExtension({
      type: WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD, requestId: 'r1', formKey: '000001:A.esp', columns: [{ formKey: '000002:B.esp', plugin: { name: 'B.esp' } }],
    })).toThrow();
  });

  it('rejects a request missing its formKey', () => {
    expect(() => parseWebviewToExtension({ type: WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD, requestId: 'r1', columns: [] })).toThrow();
  });

  it('carries the comparison, the plugin list and conflictsComputed on success', () => {
    const compare = { overrides: [], diffs: [], conflictAll: 'OnlyOne' };
    const plugins = [{ name: 'A.esp', isImmutable: true, loadOrderIndex: 0 }];
    expect(parseExtensionToWebview({
      type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: true, compare, plugins, conflictsComputed: true, loadFailures: [],
    })).toEqual({
      type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: true, compare, plugins, conflictsComputed: true, loadFailures: [],
    });
  });

  it('carries null plugins when that read failed, and a string error when the load itself did', () => {
    const compare = { overrides: [], diffs: [], conflictAll: 'OnlyOne' };
    expect(parseExtensionToWebview({
      type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: true, compare, plugins: null, conflictsComputed: false, loadFailures: [],
    })).toEqual({
      type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: true, compare, plugins: null, conflictsComputed: false, loadFailures: [],
    });

    expect(parseExtensionToWebview({ type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: false, error: 'HTTP 404' }))
      .toEqual({ type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: false, error: 'HTTP 404' });
  });

  it('carries the plugins mEdit cannot read, and rejects an answer without them', () => {
    const compare = { overrides: [], diffs: [], conflictAll: 'OnlyOne' };
    const loadFailures = [{ name: 'Bad.esp', origin: 'Mod', reason: 'truncated' }];
    const answered = { type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: true, compare, plugins: null, conflictsComputed: true };

    expect(parseExtensionToWebview({ ...answered, loadFailures })).toEqual({ ...answered, loadFailures });
    expect(() => parseExtensionToWebview(answered)).toThrow();
  });

  it('rejects an answer whose ok is missing entirely', () => {
    expect(() => parseExtensionToWebview({ type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1' })).toThrow();
  });
});
