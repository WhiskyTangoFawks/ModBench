import { describe, it, expect } from 'vitest';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, parseWebviewToExtension, parseExtensionToWebview } from '../messages';

// ADR-0015 invariant 3: a write's read-your-writes belongs to the read side, so the extension
// never posts a message announcing its own write — pinned so it cannot return by copy.
describe('EXTENSION_TO_WEBVIEW', () => {
  it('has no post-write broadcast kind', () => {
    expect(Object.values(EXTENSION_TO_WEBVIEW)).not.toContain('recordEdited');
  });
});

// commands.md, Record: a field gesture from the palette acts on the focused cell of the record tab
// in focus, so the panel says which cell that is, as the context its menu would hand the command.
describe('the focused cell message', () => {
  it('carries the focused cell\'s context, or null when no cell is focused', () => {
    const context = { webviewSection: 'arrayElement', formKey: '000001:A.esp', path: [] };
    expect(parseWebviewToExtension({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context }))
      .toEqual({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context });
    expect(parseWebviewToExtension({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: null }))
      .toEqual({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: null });
  });

  it('is refused when its context is neither an object nor null', () => {
    expect(() => parseWebviewToExtension({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: 'arrayElement' })).toThrow();
  });
});

// The record panel's own read, asked of the host rather than fetched by the webview itself
// (ADR-0002 invariant 2: nothing outside the client names the port).
describe('the record load request and its answer', () => {
  it('carries the formKey and the requestId that pairs the reply', () => {
    expect(parseWebviewToExtension({ type: WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD, requestId: 'r1', formKey: '000001:A.esp' }))
      .toEqual({ type: WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD, requestId: 'r1', formKey: '000001:A.esp' });
  });

  it('rejects a request missing its formKey', () => {
    expect(() => parseWebviewToExtension({ type: WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD, requestId: 'r1' })).toThrow();
  });

  it('carries the comparison, the plugin list and conflictsComputed on success', () => {
    const compare = { overrides: [], diffs: [], conflictAll: 'OnlyOne' };
    const plugins = [{ name: 'A.esp', isImmutable: true, loadOrderIndex: 0 }];
    expect(parseExtensionToWebview({
      type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: true, compare, plugins, conflictsComputed: true,
    })).toEqual({
      type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: true, compare, plugins, conflictsComputed: true,
    });
  });

  it('carries null plugins when that read failed, and a string error when the load itself did', () => {
    const compare = { overrides: [], diffs: [], conflictAll: 'OnlyOne' };
    expect(parseExtensionToWebview({
      type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: true, compare, plugins: null, conflictsComputed: false,
    })).toEqual({
      type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: true, compare, plugins: null, conflictsComputed: false,
    });

    expect(parseExtensionToWebview({ type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: false, error: 'HTTP 404' }))
      .toEqual({ type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: false, error: 'HTTP 404' });
  });

  it('rejects an answer whose ok is missing entirely', () => {
    expect(() => parseExtensionToWebview({ type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1' })).toThrow();
  });
});
