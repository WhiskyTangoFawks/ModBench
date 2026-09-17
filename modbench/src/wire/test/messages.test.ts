import { describe, it, expect } from 'vitest';
import { EXTENSION_TO_WEBVIEW } from '../messages';

// ADR-0015 invariant 3: a write's read-your-writes belongs to the read side, so the extension
// never posts a message announcing its own write — pinned so it cannot return by copy.
describe('EXTENSION_TO_WEBVIEW', () => {
  it('has no post-write broadcast kind', () => {
    expect(Object.values(EXTENSION_TO_WEBVIEW)).not.toContain('recordEdited');
  });
});
