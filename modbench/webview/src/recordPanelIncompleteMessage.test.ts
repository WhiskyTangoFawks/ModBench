import { describe, it, expect } from 'vitest';
import { recordPanelIncompleteMessage } from './recordPanelIncompleteMessage';

describe('recordPanelIncompleteMessage, gated on `conflictsComputed` alone, as the whole-set sweep leaves a Ready load order with stale winners until it re-runs', () => {
  it('is exactly the reviewed wording, which names both that the comparison is incomplete and that the colours are not final, as an absent conflict badge looks the same as "no conflict"', () => {
    expect(recordPanelIncompleteMessage(false)).toBe(
      'This record\'s comparison is not complete: the colours are not final.',
    );
  });

  it('clears once the sweep completes, so the statement disappears with no user action', () => {
    expect(recordPanelIncompleteMessage(true)).toBeUndefined();
  });

  it('never uses "mod" as a common noun, as the Editor speaks of records, FormKeys and plugins', () => {
    expect(recordPanelIncompleteMessage(false)).not.toMatch(/\bmod\b/i);
  });
});
