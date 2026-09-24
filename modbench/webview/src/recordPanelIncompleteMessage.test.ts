import { describe, it, expect } from 'vitest';
import { recordPanelIncompleteMessage } from './recordPanelIncompleteMessage';

// ADR-0013: an absent conflict badge is indistinguishable from "no conflict", so the statement
// names both facts. Gated on `conflictsComputed` alone — the whole-set sweep leaves a Ready
// load order with stale winners until it re-runs.
describe('recordPanelIncompleteMessage', () => {
  it('states both that the comparison is incomplete and that colouring is not final while the sweep is outstanding', () => {
    const message = recordPanelIncompleteMessage(false);

    expect(message).toMatch(/comparison.*not.*complete/i);
    expect(message).toMatch(/colouring.*not final/i);
  });

  // An exact-string test, not just a substring/vocabulary check, so a future
  // reword is a deliberate, reviewed choice rather than a silent drift.
  it('is exactly the reviewed wording', () => {
    expect(recordPanelIncompleteMessage(false)).toBe(
      'This record\'s comparison is not yet complete: conflict information has not been computed '
      + 'for every plugin, so the colouring here is not final.',
    );
  });

  it('clears once the sweep completes, so the statement disappears with no user action', () => {
    expect(recordPanelIncompleteMessage(true)).toBeUndefined();
  });

  // Never Mod Management's vocabulary ("mod") as a common noun: the Editor speaks of records,
  // FormKeys and plugins.
  it('never uses "mod" as a common noun', () => {
    expect(recordPanelIncompleteMessage(false)).not.toMatch(/\bmod\b/i);
  });
});
