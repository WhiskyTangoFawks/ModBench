import { describe, it, expect } from 'vitest';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, parseWebviewToExtension } from '../messages';

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
