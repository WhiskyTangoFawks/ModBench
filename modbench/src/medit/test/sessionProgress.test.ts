import { describe, it, expect } from 'vitest';
import { sessionProgressMessage } from '../sessionProgress';

// #307 / ADR-0035 AC3/AC5. The trap: an absent conflict badge is indistinguishable from "no
// conflict", so while the winner sweep is outstanding the view has to *say* so in as many words.
// It is gated on `conflictsComputed` alone — never on whether a load happens to be running —
// because the sweep is whole-set, and ADR-0035's live mutations will leave a finished session
// with stale winners that nothing has re-swept.
describe('sessionProgressMessage', () => {
  const status = (over: Partial<Parameters<typeof sessionProgressMessage>[0]> = {}) =>
    ({ totalPlugins: 200, indexedPlugins: [], conflictsComputed: false, failures: [], ...over });

  it('says conflict information is not yet computed while the sweep is outstanding', () => {
    const message = sessionProgressMessage(status({ conflictsComputed: false }));

    expect(message).toMatch(/conflict information is not yet computed/i);
  });

  it('clears once the sweep completes, so the statement disappears with no user action', () => {
    const message = sessionProgressMessage(status({ conflictsComputed: true }));

    expect(message).toBeUndefined();
  });

  it('names how many of how many plugins have been indexed so far', () => {
    const message = sessionProgressMessage(status({
      totalPlugins: 200,
      indexedPlugins: Array.from({ length: 12 }, (_, i) => `P${i}.esp`),
    }));

    expect(message).toContain('12 of 200');
  });

  // Before the backend publishes the session at all, `GET /session/status` answers
  // SessionStatus.None — no plugins, and no count yet (SessionManager.cs). "0 of 0 plugins
  // indexed" is a number the user would read as a stalled load rather than as one still opening
  // the load order, so the count is omitted until there is one.
  it('omits the count entirely before the load knows how many plugins there are', () => {
    const message = sessionProgressMessage(status({ totalPlugins: 0, indexedPlugins: [] }));

    expect(message).not.toContain('0');
    expect(message).toMatch(/conflict information is not yet computed/i);
  });
});
