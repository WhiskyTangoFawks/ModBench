import { describe, it, expect } from 'vitest';
import { isPluginAddress, EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, parseWebviewToExtension, parseExtensionToWebview } from '../messages';

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

  it.each([
    ['webviewSection', 7], ['canMoveUp', 'yes'], ['canMoveDown', 1], ['copyText', 7], ['editorOpen', 'true'],
  ])('is refused when its %s is of another type', (member, value) => {
    expect(() => parseWebviewToExtension({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: { [member]: value }, entered: true })).toThrow();
  });

  it('is refused without saying whether the user entered the cell', () => {
    expect(() => parseWebviewToExtension({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: null })).toThrow();
  });
});

describe('the place a grid tells the host, which the tab a move of its file opens shows again', () => {
  const state = { collapsedRows: ['Bounds'], collapsedColumns: ['A.esp|ModA'], focusedCell: { rowKey: 'Bounds', plugin: null }, scroll: { top: 4, left: 0 } };

  it('carries the rows and columns collapsed, the focused cell and the scroll', () => {
    expect(parseWebviewToExtension({ type: WEBVIEW_TO_EXTENSION.VIEW_STATE, state }))
      .toEqual({ type: WEBVIEW_TO_EXTENSION.VIEW_STATE, state });
    expect(parseWebviewToExtension({ type: WEBVIEW_TO_EXTENSION.VIEW_STATE, state: { ...state, focusedCell: null } }))
      .toEqual({ type: WEBVIEW_TO_EXTENSION.VIEW_STATE, state: { ...state, focusedCell: null } });
  });

  it('is refused without its scroll, or with a focused cell that names no row', () => {
    expect(() => parseWebviewToExtension({ type: WEBVIEW_TO_EXTENSION.VIEW_STATE, state: { ...state, scroll: undefined } })).toThrow();
    expect(() => parseWebviewToExtension({ type: WEBVIEW_TO_EXTENSION.VIEW_STATE, state: { ...state, focusedCell: { plugin: null } } })).toThrow();
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
      type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: true, compare, plugins, conflictsComputed: true, loadFailures: [], documentPlugin: { name: 'A.esp', origin: 'ModA' }, modsByOrigin: { ModA: 'tracked' }, fileCopyAlone: true, fileOverriddenBy: null,
    })).toEqual({
      type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: true, compare, plugins, conflictsComputed: true, loadFailures: [], documentPlugin: { name: 'A.esp', origin: 'ModA' }, modsByOrigin: { ModA: 'tracked' }, fileCopyAlone: true, fileOverriddenBy: null,
    });
  });

  it('carries null plugins when that read failed, and a read failure when the load itself did', () => {
    const compare = { overrides: [], diffs: [], conflictAll: 'OnlyOne' };
    expect(parseExtensionToWebview({
      type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: true, compare, plugins: null, conflictsComputed: false, loadFailures: [], documentPlugin: { name: 'A.esp', origin: 'ModA' }, modsByOrigin: { ModA: 'tracked' }, fileCopyAlone: false, fileOverriddenBy: null,
    })).toEqual({
      type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: true, compare, plugins: null, conflictsComputed: false, loadFailures: [], documentPlugin: { name: 'A.esp', origin: 'ModA' }, modsByOrigin: { ModA: 'tracked' }, fileCopyAlone: false, fileOverriddenBy: null,
    });

    expect(parseExtensionToWebview({ type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: false, failure: { failed: 'refused', refusal: 'No such record.' } }))
      .toEqual({ type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: false, failure: { failed: 'refused', refusal: 'No such record.' } });
  });

  it('rejects an answer that does not say whether the file\'s copy is read alone', () => {
    const answered = {
      type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: true, compare: { overrides: [], diffs: [], conflictAll: 'OnlyOne' }, plugins: null,
      conflictsComputed: true, loadFailures: [], documentPlugin: { name: 'A.esp', origin: 'ModA' }, modsByOrigin: {},
    };

    expect(() => parseExtensionToWebview(answered)).toThrow(/fileCopyAlone/);
    expect(() => parseExtensionToWebview({ ...answered, fileCopyAlone: 'yes' })).toThrow(/fileCopyAlone/);
  });

  it('rejects an answer that does not say which mod overrides the file\'s plugin, or null', () => {
    const answered = {
      type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: true, compare: { overrides: [], diffs: [], conflictAll: 'OnlyOne' }, plugins: null,
      conflictsComputed: true, loadFailures: [], documentPlugin: { name: 'A.esp', origin: 'ModA' }, modsByOrigin: {}, fileCopyAlone: false,
    };

    expect(() => parseExtensionToWebview(answered)).toThrow(/overriding mod/);
    expect(() => parseExtensionToWebview({ ...answered, fileOverriddenBy: 4 })).toThrow(/overriding mod/);
  });

  it('carries the plugins mEdit cannot read, and rejects an answer without them', () => {
    const compare = { overrides: [], diffs: [], conflictAll: 'OnlyOne' };
    const loadFailures = [{ name: 'Bad.esp', origin: 'Mod', reason: 'truncated' }];
    const answered = { type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: true, compare, plugins: null, conflictsComputed: true, documentPlugin: { name: 'A.esp', origin: 'ModA' }, modsByOrigin: { ModA: 'tracked' }, fileCopyAlone: false, fileOverriddenBy: null };

    expect(parseExtensionToWebview({ ...answered, loadFailures })).toEqual({ ...answered, loadFailures });
    expect(() => parseExtensionToWebview(answered)).toThrow();
  });

  it('rejects an answer with no comparison that names no record as gone, and carries the ones it names', () => {
    const answered = {
      type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: true, compare: null, plugins: null, conflictsComputed: true,
      loadFailures: [], documentPlugin: { name: 'A.esp', origin: 'ModA' }, modsByOrigin: {}, fileCopyAlone: false, fileOverriddenBy: null, copiesLacking: [],
    };

    expect(() => parseExtensionToWebview(answered)).toThrow(/gone/);
    expect(() => parseExtensionToWebview({ ...answered, gone: [] })).toThrow(/gone/);
    expect(() => parseExtensionToWebview({ ...answered, gone: ['000001:A.esp'], copiesLacking: undefined })).toThrow(/gone/);
    expect(parseExtensionToWebview({ ...answered, gone: ['000001:A.esp'] })).toEqual({ ...answered, gone: ['000001:A.esp'] });
  });

  it('rejects an answer that names no plugin whole as the one whose copy the tab\'s document holds', () => {
    const answered = {
      type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: true, compare: null, plugins: null, conflictsComputed: true, loadFailures: [],
    };

    expect(() => parseExtensionToWebview(answered)).toThrow();
    expect(() => parseExtensionToWebview({ ...answered, documentPlugin: { name: 'A.esp' } })).toThrow();
  });

  it('carries the mods by origin the host says changed, and rejects a change that names a state other than tracked or untracked', () => {
    const changed = { type: EXTENSION_TO_WEBVIEW.MODS_CHANGED, modsByOrigin: { ModA: 'tracked' } };

    expect(parseExtensionToWebview(changed)).toEqual(changed);
    expect(() => parseExtensionToWebview({ ...changed, modsByOrigin: { ModA: 'none' } })).toThrow();
    expect(() => parseExtensionToWebview({ type: EXTENSION_TO_WEBVIEW.MODS_CHANGED })).toThrow();
  });

  it('rejects an answer whose mods by origin are missing or name a state other than tracked or untracked', () => {
    const answered = {
      type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: true, compare: null, gone: ['000001:A.esp'], copiesLacking: [], plugins: null, conflictsComputed: true,
      loadFailures: [], documentPlugin: { name: 'A.esp', origin: 'ModA' }, fileCopyAlone: false, fileOverriddenBy: null,
    };

    expect(() => parseExtensionToWebview(answered)).toThrow();
    expect(() => parseExtensionToWebview({ ...answered, modsByOrigin: { ModA: 'none' } })).toThrow();
    expect(() => parseExtensionToWebview({ ...answered, modsByOrigin: { ModA: 'untracked' } })).not.toThrow();
  });

  it('carries the records a column\'s header opens, and rejects one that names no plugin whole', () => {
    const records = [{ formKey: '000002:B.esp', plugin: { name: 'B.esp', origin: 'ModB' } }];

    expect(parseWebviewToExtension({ type: WEBVIEW_TO_EXTENSION.OPEN_COLUMNS, records }))
      .toEqual({ type: WEBVIEW_TO_EXTENSION.OPEN_COLUMNS, records });
    expect(() => parseWebviewToExtension({ type: WEBVIEW_TO_EXTENSION.OPEN_COLUMNS, records: [{ formKey: '000002:B.esp', plugin: { name: 'B.esp' } }] })).toThrow();
  });

  it('rejects an answer whose ok is missing entirely', () => {
    expect(() => parseExtensionToWebview({ type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1' })).toThrow();
  });
});

describe('isPluginAddress', () => {
  it('holds a name and an origin, both strings', () => {
    expect(isPluginAddress({ name: 'A.esp', origin: 'Mod' })).toBe(true);
    expect(isPluginAddress({ name: 'A.esp' })).toBe(false);
    expect(isPluginAddress({ name: 'A.esp', origin: 1 })).toBe(false);
    expect(isPluginAddress(null)).toBe(false);
  });
});
