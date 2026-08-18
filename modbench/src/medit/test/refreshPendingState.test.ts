import { describe, it, expect, vi } from 'vitest';
import { refreshPendingState } from '../refreshPendingState';

// #368 AC3 ("the provider updates when edits are staged/saved/reverted"), at the seam that
// actually proves it: every real call site (SessionController's refreshGroupTree callback,
// recordPanelMessageRouter's PENDING_CHANGED branch, extension.ts's session-load-complete block)
// goes through this one function rather than pairing providers by hand — so this is the test that
// fails if a future provider (or a future call site) drifts out of sync with the other two, the
// exact regression #331 already had once between changeGroupTree and pendingChangeDecoration.
describe('refreshPendingState', () => {
  it('refreshes the change-group tree unconditionally', () => {
    const changeGroupTree = { refresh: vi.fn() };

    refreshPendingState({ changeGroupTree });

    expect(changeGroupTree.refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes the pending-change decoration provider and the ledger SCM provider together with it, when both are supplied', () => {
    const changeGroupTree = { refresh: vi.fn() };
    const pendingChangeDecoration = { refresh: vi.fn() };
    const ledgerScm = { refresh: vi.fn() };

    refreshPendingState({ changeGroupTree, pendingChangeDecoration, ledgerScm });

    expect(pendingChangeDecoration.refresh).toHaveBeenCalledTimes(1);
    expect(ledgerScm.refresh).toHaveBeenCalledTimes(1);
  });

  it('defaults retainOnFailure to true on the decoration provider, same as its own class default', () => {
    const changeGroupTree = { refresh: vi.fn() };
    const pendingChangeDecoration = { refresh: vi.fn() };

    refreshPendingState({ changeGroupTree, pendingChangeDecoration });

    expect(pendingChangeDecoration.refresh).toHaveBeenCalledWith(true);
  });

  it('passes retainOnFailure through when the caller states it (session load/exit: no trustworthy prior-session baseline)', () => {
    const changeGroupTree = { refresh: vi.fn() };
    const pendingChangeDecoration = { refresh: vi.fn() };

    refreshPendingState({ changeGroupTree, pendingChangeDecoration }, false);

    expect(pendingChangeDecoration.refresh).toHaveBeenCalledWith(false);
  });

  it('tolerates either optional target being absent, without throwing', () => {
    const changeGroupTree = { refresh: vi.fn() };

    expect(() => refreshPendingState({ changeGroupTree })).not.toThrow();
  });
});
