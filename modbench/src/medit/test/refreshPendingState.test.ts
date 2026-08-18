import { describe, it, expect, vi } from 'vitest';
import { refreshPendingState, buildPendingStateTargets } from '../refreshPendingState';

// #368 AC3 ("the provider updates when edits are staged/saved/reverted"), at the seam that
// actually proves it: every real call site (SessionController's refreshGroupTree callback,
// recordPanelMessageRouter's PENDING_CHANGED branch, extension.ts's session-load-complete block)
// goes through this one function rather than pairing providers by hand — so this is the test that
// fails if a future provider (or a future call site) drifts out of sync with the other two, the
// exact regression #331 already had once between changeGroupTree and pendingChangeDecoration.
describe('refreshPendingState', () => {
  it('refreshes the change-group tree unconditionally', async () => {
    const changeGroupTree = { refresh: vi.fn() };

    await refreshPendingState({ changeGroupTree });

    expect(changeGroupTree.refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes the pending-change decoration provider and the ledger SCM provider together with it, when both are supplied', async () => {
    const changeGroupTree = { refresh: vi.fn() };
    const pendingChangeDecoration = { refresh: vi.fn() };
    const ledgerScm = { refresh: vi.fn() };

    await refreshPendingState({ changeGroupTree, pendingChangeDecoration, ledgerScm });

    expect(pendingChangeDecoration.refresh).toHaveBeenCalledTimes(1);
    expect(ledgerScm.refresh).toHaveBeenCalledTimes(1);
  });

  it('defaults retainOnFailure to true on the decoration provider, same as its own class default', async () => {
    const changeGroupTree = { refresh: vi.fn() };
    const pendingChangeDecoration = { refresh: vi.fn() };

    await refreshPendingState({ changeGroupTree, pendingChangeDecoration });

    expect(pendingChangeDecoration.refresh).toHaveBeenCalledWith(true);
  });

  it('passes retainOnFailure through when the caller states it (session load/exit: no trustworthy prior-session baseline)', async () => {
    const changeGroupTree = { refresh: vi.fn() };
    const pendingChangeDecoration = { refresh: vi.fn() };

    await refreshPendingState({ changeGroupTree, pendingChangeDecoration }, false);

    expect(pendingChangeDecoration.refresh).toHaveBeenCalledWith(false);
  });

  it('tolerates either optional target being absent, without throwing', async () => {
    const changeGroupTree = { refresh: vi.fn() };

    await expect(refreshPendingState({ changeGroupTree })).resolves.toBeUndefined();
  });

  // #368 review finding 5: a synchronous throw from the first target used to skip the other two
  // outright — defeating the whole point of a *shared* signal. Each target is now isolated.
  it('a synchronous throw from changeGroupTree.refresh() does not skip the other two targets', async () => {
    const changeGroupTree = { refresh: vi.fn(() => { throw new Error('boom'); }) };
    const pendingChangeDecoration = { refresh: vi.fn() };
    const ledgerScm = { refresh: vi.fn() };

    await expect(refreshPendingState({ changeGroupTree, pendingChangeDecoration, ledgerScm })).resolves.toBeUndefined();

    expect(pendingChangeDecoration.refresh).toHaveBeenCalledTimes(1);
    expect(ledgerScm.refresh).toHaveBeenCalledTimes(1);
  });

  it('a rejected async refresh from pendingChangeDecoration does not skip ledgerScm, and never rejects the caller', async () => {
    const changeGroupTree = { refresh: vi.fn() };
    const pendingChangeDecoration = { refresh: vi.fn(() => Promise.reject(new Error('backend down'))) };
    const ledgerScm = { refresh: vi.fn() };

    await expect(refreshPendingState({ changeGroupTree, pendingChangeDecoration, ledgerScm })).resolves.toBeUndefined();

    expect(ledgerScm.refresh).toHaveBeenCalledTimes(1);
  });

  // Failures must be visible, not swallowed (#368 review finding 5) — both the synchronous and
  // the async failure shape.
  it('logs a synchronous throw, naming which target failed', async () => {
    const changeGroupTree = { refresh: vi.fn(() => { throw new Error('boom'); }) };
    const log = vi.fn();

    await refreshPendingState({ changeGroupTree }, true, log);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('changeGroupTree'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('logs a rejected async refresh, naming which target failed', async () => {
    const changeGroupTree = { refresh: vi.fn() };
    const ledgerScm = { refresh: vi.fn(() => Promise.reject(new Error('backend down'))) };
    const log = vi.fn();

    await refreshPendingState({ changeGroupTree, ledgerScm }, true, log);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('ledgerScm'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('backend down'));
  });
});

// #368 review finding 8: the two extension.ts call sites (SessionController's refreshGroupTree
// callback, the session-load reset in makeEnterEditing) were inline object literals no test
// covered — a dropped `ledgerScm:` there would go unnoticed, so "updates when saved or reverted"
// was never actually proven, only "staged" (the PENDING_CHANGED route, which already had coverage).
// buildPendingStateTargets replaces the object literal with required *positional* parameters: a
// call site that forgets one is a compile error, not a gap a test has to catch after the fact —
// this suite is the runtime half of that guard, proving the shape it actually produces.
describe('buildPendingStateTargets', () => {
  it('bundles all three targets by position, unchanged', () => {
    const changeGroupTree = { refresh: vi.fn() };
    const pendingChangeDecoration = { refresh: vi.fn() };
    const ledgerScm = { refresh: vi.fn() };

    const targets = buildPendingStateTargets(changeGroupTree, pendingChangeDecoration, ledgerScm);

    expect(targets).toEqual({ changeGroupTree, pendingChangeDecoration, ledgerScm });
  });

  it('carries an explicit undefined through for a provider not yet constructed, rather than requiring the caller to omit it', () => {
    const changeGroupTree = { refresh: vi.fn() };

    const targets = buildPendingStateTargets(changeGroupTree, undefined, undefined);

    expect(targets).toEqual({ changeGroupTree, pendingChangeDecoration: undefined, ledgerScm: undefined });
  });
});
