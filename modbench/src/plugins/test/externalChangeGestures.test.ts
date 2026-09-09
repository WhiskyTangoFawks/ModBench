import { describe, it, expect, vi } from 'vitest';
import { runRebase, rebaseOfferMessage, handleUnanswered } from '../externalChangeGestures';
import { KEEP_BUTTON, ABSORB_BUTTON } from '../externalChangeDialog';
import type { UnansweredExternalChange } from '../../medit/client';

function makeRebaseDeps(controller: unknown) {
  return {
    controller,
    openMergeEditor: vi.fn().mockResolvedValue(undefined),
    showError: vi.fn(),
    refreshTree: vi.fn(),
    refreshMatchingPlugins: vi.fn(),
  } as any;
}

describe('rebaseOfferMessage', () => {
  it('names the edit branch and the origin', () => {
    expect(rebaseOfferMessage('ModA')).toBe('main moved ahead of "edit" in ModA.');
  });
});

describe('runRebase', () => {
  it('opens the native merge editor on every conflicted path', async () => {
    const controller = { rebaseOntoMain: vi.fn().mockResolvedValue({ outcome: 'Conflicted', refusalReason: null, conflictedPaths: ['source/A.esp/x.json', 'source/A.esp/y.json'] }) };
    const deps = makeRebaseDeps(controller);

    const result = await runRebase(deps, 'ModA');

    expect(result?.outcome).toBe('Conflicted');
    expect(deps.openMergeEditor).toHaveBeenCalledTimes(2);
    expect(deps.openMergeEditor).toHaveBeenCalledWith('ModA', 'source/A.esp/x.json');
    expect(deps.openMergeEditor).toHaveBeenCalledWith('ModA', 'source/A.esp/y.json');
  });

  it('opens nothing on a clean rebase', async () => {
    const controller = { rebaseOntoMain: vi.fn().mockResolvedValue({ outcome: 'Clean', refusalReason: null, conflictedPaths: [] }) };
    const deps = makeRebaseDeps(controller);

    await runRebase(deps, 'ModA');

    expect(deps.openMergeEditor).not.toHaveBeenCalled();
  });

  // Refresh happens either way — a `Conflicted` outcome leaves the repo mid-rebase, which the
  // panel must still reflect.
  it('refreshes the tree and matching-plugin set on both a clean and a conflicted outcome', async () => {
    const controller = { rebaseOntoMain: vi.fn().mockResolvedValue({ outcome: 'Conflicted', refusalReason: null, conflictedPaths: ['a.json'] }) };
    const deps = makeRebaseDeps(controller);

    await runRebase(deps, 'ModA');

    expect(deps.refreshTree).toHaveBeenCalledOnce();
    expect(deps.refreshMatchingPlugins).toHaveBeenCalledOnce();
  });

  it('shows the ready-to-show message and refreshes nothing when the backend refuses the rebase outright', async () => {
    const controller = { rebaseOntoMain: vi.fn().mockResolvedValue({ refused: true, message: 'mEdit: Could not rebase "ModA" — boom' }) };
    const deps = makeRebaseDeps(controller);

    const result = await runRebase(deps, 'ModA');

    expect(result).toBeNull();
    expect(deps.showError).toHaveBeenCalledWith('mEdit: Could not rebase "ModA" — boom');
    expect(deps.refreshTree).not.toHaveBeenCalled();
  });
});

function unanswered(over: Partial<UnansweredExternalChange> = {}): UnansweredExternalChange {
  return { plugin: 'Fixture.esp', origin: 'ModA', metaChanged: false, oldVersion: null, newVersion: null, ...over };
}

function makeDispatchDeps(controller: unknown, showDialogChoice: string | undefined) {
  return {
    controller,
    showDialog: vi.fn().mockResolvedValue(showDialogChoice),
    showRebaseOffer: vi.fn().mockResolvedValue(undefined),
    openMergeEditor: vi.fn(),
    showError: vi.fn(),
    refreshTree: vi.fn(),
    refreshMatchingPlugins: vi.fn(),
  } as any;
}

describe('handleUnanswered', () => {
  it('a landed Keep refreshes the tree and the matching-plugin set', async () => {
    const controller = { keepAsMyEdit: vi.fn().mockResolvedValue({ succeeded: true, refusalReason: null }) };
    const deps = makeDispatchDeps(controller, KEEP_BUTTON);

    await handleUnanswered(deps, [unanswered()]);

    expect(controller.keepAsMyEdit).toHaveBeenCalledWith('Fixture.esp', 'ModA');
    expect(deps.refreshTree).toHaveBeenCalledOnce();
    expect(deps.refreshMatchingPlugins).toHaveBeenCalledOnce();
  });

  // The rival: a refused Keep (a same-record collision) still refreshing would show the user a
  // tree that changed when nothing actually landed.
  it('a refused Keep does not refresh', async () => {
    const controller = { keepAsMyEdit: vi.fn().mockResolvedValue({ succeeded: false, refusalReason: 'collision' }) };
    const deps = makeDispatchDeps(controller, KEEP_BUTTON);

    await handleUnanswered(deps, [unanswered()]);

    expect(deps.refreshTree).not.toHaveBeenCalled();
  });

  it('a WriteRefused Keep shows the ready-to-show message', async () => {
    const controller = { keepAsMyEdit: vi.fn().mockResolvedValue({ refused: true, message: 'mEdit: Could not keep "Fixture.esp" as your own edit — boom' }) };
    const deps = makeDispatchDeps(controller, KEEP_BUTTON);

    await handleUnanswered(deps, [unanswered()]);

    expect(deps.showError).toHaveBeenCalledWith('mEdit: Could not keep "Fixture.esp" as your own edit — boom');
    expect(deps.refreshTree).not.toHaveBeenCalled();
  });

  it('a landed Absorb refreshes and offers the rebase', async () => {
    const controller = {
      absorbUpstreamUpdate: vi.fn().mockResolvedValue({ succeeded: true, refusalReason: null }),
      rebaseOntoMain: vi.fn(),
    };
    const deps = makeDispatchDeps(controller, ABSORB_BUTTON);

    await handleUnanswered(deps, [unanswered()]);

    expect(deps.refreshTree).toHaveBeenCalledOnce();
    expect(deps.showRebaseOffer).toHaveBeenCalledOnce();
  });

  // A typed refusal (e.g. "could not be parsed") rides a 200 as `succeeded: false` — this is
  // exactly the case `WriteRefused` never sees, so it must still be surfaced here.
  it('a typed Absorb refusal shows its own message and never offers the rebase', async () => {
    const controller = {
      absorbUpstreamUpdate: vi.fn().mockResolvedValue({ succeeded: false, refusalReason: 'could not be parsed' }),
    };
    const deps = makeDispatchDeps(controller, ABSORB_BUTTON);

    await handleUnanswered(deps, [unanswered()]);

    expect(deps.showError).toHaveBeenCalledWith(
      'mEdit: Could not absorb the upstream update for "Fixture.esp" — could not be parsed',
    );
    expect(deps.showRebaseOffer).not.toHaveBeenCalled();
    expect(deps.refreshTree).not.toHaveBeenCalled();
  });

  it('declining the dialog (defer) calls neither verb', async () => {
    const controller = { keepAsMyEdit: vi.fn(), absorbUpstreamUpdate: vi.fn() };
    const deps = makeDispatchDeps(controller, undefined);

    await handleUnanswered(deps, [unanswered()]);

    expect(controller.keepAsMyEdit).not.toHaveBeenCalled();
    expect(controller.absorbUpstreamUpdate).not.toHaveBeenCalled();
  });
});
