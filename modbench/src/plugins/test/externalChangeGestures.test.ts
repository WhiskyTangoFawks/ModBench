import { describe, it, expect, vi } from 'vitest';
import { runRebase, handleUnanswered } from '../externalChangeGestures';
import { APPLY_BUTTON, BASELINE_BUTTON } from '../externalChangeDialog';
import type { UnansweredExternalChange } from '../../medit/client';

function makeRebaseDeps(client: unknown) {
  return {
    client,
    openMergeEditor: vi.fn().mockResolvedValue(undefined),
    showError: vi.fn(),
    refreshTree: vi.fn(),
    refreshMatchingPlugins: vi.fn(),
  } as any;
}

describe('runRebase', () => {
  it('opens the native merge editor on every conflicted path', async () => {
    const client = { rebaseOntoMain: vi.fn().mockResolvedValue({ outcome: 'Conflicted', refusalReason: null, conflictedPaths: ['source/A.esp/x.json', 'source/A.esp/y.json'] }) };
    const deps = makeRebaseDeps(client);

    const result = await runRebase(deps, 'ModA');

    expect(result?.outcome).toBe('Conflicted');
    expect(deps.openMergeEditor).toHaveBeenCalledTimes(2);
    expect(deps.openMergeEditor).toHaveBeenCalledWith('ModA', 'source/A.esp/x.json');
    expect(deps.openMergeEditor).toHaveBeenCalledWith('ModA', 'source/A.esp/y.json');
  });

  it('opens nothing on a clean rebase', async () => {
    const client = { rebaseOntoMain: vi.fn().mockResolvedValue({ outcome: 'Clean', refusalReason: null, conflictedPaths: [] }) };
    const deps = makeRebaseDeps(client);

    await runRebase(deps, 'ModA');

    expect(deps.openMergeEditor).not.toHaveBeenCalled();
  });

  // Refresh happens either way — a `Conflicted` outcome leaves the repo mid-rebase, which the
  // panel must still reflect.
  it('refreshes the tree and matching-plugin set on both a clean and a conflicted outcome', async () => {
    const client = { rebaseOntoMain: vi.fn().mockResolvedValue({ outcome: 'Conflicted', refusalReason: null, conflictedPaths: ['a.json'] }) };
    const deps = makeRebaseDeps(client);

    await runRebase(deps, 'ModA');

    expect(deps.refreshTree).toHaveBeenCalledOnce();
    expect(deps.refreshMatchingPlugins).toHaveBeenCalledOnce();
  });

  it('shows the ready-to-show message and refreshes nothing when the backend refuses the rebase outright', async () => {
    const client = { rebaseOntoMain: vi.fn().mockResolvedValue({ refused: true, message: 'mEdit: Could not rebase "ModA" — boom' }) };
    const deps = makeRebaseDeps(client);

    const result = await runRebase(deps, 'ModA');

    expect(result).toBeNull();
    expect(deps.showError).toHaveBeenCalledWith('mEdit: Could not rebase "ModA" — boom');
    expect(deps.refreshTree).not.toHaveBeenCalled();
  });
});

function unanswered(over: Partial<UnansweredExternalChange> = {}): UnansweredExternalChange {
  return {
    origin: 'ModA', plugins: ['Fixture.esp'], trackedFiles: [], metaChanged: false, oldVersion: null, newVersion: null,
    ...over,
  };
}

function makeDispatchDeps(client: unknown, showDialogChoice: string | undefined) {
  return {
    client,
    showDialog: vi.fn().mockResolvedValue(showDialogChoice),
    openMergeEditor: vi.fn().mockResolvedValue(undefined),
    showError: vi.fn(),
    refreshTree: vi.fn(),
    refreshMatchingPlugins: vi.fn(),
  } as any;
}

describe('handleUnanswered', () => {
  it('a landed Keep refreshes the tree and the matching-plugin set', async () => {
    const client = { keepAsMyEdit: vi.fn().mockResolvedValue({ succeeded: true, refusalReason: null }) };
    const deps = makeDispatchDeps(client, APPLY_BUTTON);

    await handleUnanswered(deps, [unanswered()]);

    expect(client.keepAsMyEdit).toHaveBeenCalledWith('ModA');
    expect(deps.refreshTree).toHaveBeenCalledOnce();
    expect(deps.refreshMatchingPlugins).toHaveBeenCalledOnce();
  });

  // A safety net: two notifications sharing one origin must still dispatch exactly one call.
  it('two notifications sharing one origin dispatch one call, not two', async () => {
    const client = { keepAsMyEdit: vi.fn().mockResolvedValue({ succeeded: true, refusalReason: null }) };
    const deps = makeDispatchDeps(client, APPLY_BUTTON);

    await handleUnanswered(deps, [unanswered({ plugins: ['A.esp'] }), unanswered({ plugins: ['B.esp'] })]);

    expect(client.keepAsMyEdit).toHaveBeenCalledTimes(1);
    expect(client.keepAsMyEdit).toHaveBeenCalledWith('ModA');
  });

  // The rival: a refused Keep (a same-record collision) still refreshing would show the user a
  // tree that changed when nothing actually landed.
  it('a refused Keep does not refresh', async () => {
    const client = { keepAsMyEdit: vi.fn().mockResolvedValue({ succeeded: false, refusalReason: 'collision' }) };
    const deps = makeDispatchDeps(client, APPLY_BUTTON);

    await handleUnanswered(deps, [unanswered()]);

    expect(deps.refreshTree).not.toHaveBeenCalled();
  });

  it('a WriteRefused Keep shows the ready-to-show message', async () => {
    const client = { keepAsMyEdit: vi.fn().mockResolvedValue({ refused: true, message: 'mEdit: Could not keep "ModA" as your own edit — boom' }) };
    const deps = makeDispatchDeps(client, APPLY_BUTTON);

    await handleUnanswered(deps, [unanswered()]);

    expect(deps.showError).toHaveBeenCalledWith('mEdit: Could not keep "ModA" as your own edit — boom');
    expect(deps.refreshTree).not.toHaveBeenCalled();
  });

  // A collision rides a 200 as `succeeded: false` — `WriteRefused` above never sees this case.
  it('a typed Keep refusal shows its own message', async () => {
    const client = { keepAsMyEdit: vi.fn().mockResolvedValue({ succeeded: false, refusalReason: 'x' }) };
    const deps = makeDispatchDeps(client, APPLY_BUTTON);

    await handleUnanswered(deps, [unanswered()]);

    expect(deps.showError).toHaveBeenCalledWith('Could not keep "ModA" as your own edit — x');
    expect(deps.refreshTree).not.toHaveBeenCalled();
  });

  it('a landed Absorb with a clean rebase refreshes silently', async () => {
    const client = {
      absorbUpstreamUpdate: vi.fn().mockResolvedValue({
        succeeded: true, refusalReason: null, rebase: { outcome: 'Clean', refusalReason: null, conflictedPaths: [] },
      }),
    };
    const deps = makeDispatchDeps(client, BASELINE_BUTTON);

    await handleUnanswered(deps, [unanswered()]);

    expect(deps.refreshTree).toHaveBeenCalledOnce();
    expect(deps.showError).not.toHaveBeenCalled();
    expect(deps.openMergeEditor).not.toHaveBeenCalled();
  });

  // The rebase runs server-side inside Absorb; a refusal there (uncommitted dirt) is this
  // ready-to-show reason, the same surface every other gesture's refusal shows through.
  it('a landed Absorb with a refused rebase shows the reason naming the paths', async () => {
    const client = {
      absorbUpstreamUpdate: vi.fn().mockResolvedValue({
        succeeded: true, refusalReason: null,
        rebase: { outcome: 'Refused', refusalReason: 'Cannot rebase: uncommitted changes in source/A.esp/x.json.', conflictedPaths: [] },
      }),
    };
    const deps = makeDispatchDeps(client, BASELINE_BUTTON);

    await handleUnanswered(deps, [unanswered()]);

    expect(deps.showError).toHaveBeenCalledWith('Cannot rebase: uncommitted changes in source/A.esp/x.json.');
    expect(deps.refreshTree).toHaveBeenCalledOnce();
  });

  it('a landed Absorb with a conflicted rebase opens the merge editor on every conflicted path', async () => {
    const client = {
      absorbUpstreamUpdate: vi.fn().mockResolvedValue({
        succeeded: true, refusalReason: null,
        rebase: { outcome: 'Conflicted', refusalReason: null, conflictedPaths: ['source/A.esp/x.json', 'source/A.esp/y.json'] },
      }),
    };
    const deps = makeDispatchDeps(client, BASELINE_BUTTON);

    await handleUnanswered(deps, [unanswered()]);

    expect(deps.openMergeEditor).toHaveBeenCalledTimes(2);
    expect(deps.openMergeEditor).toHaveBeenCalledWith('ModA', 'source/A.esp/x.json');
    expect(deps.openMergeEditor).toHaveBeenCalledWith('ModA', 'source/A.esp/y.json');
    expect(deps.refreshTree).toHaveBeenCalledOnce();
  });

  // A typed refusal (e.g. "could not be parsed") rides a 200 as `succeeded: false` — this is
  // exactly the case `WriteRefused` never sees, so it must still be surfaced here.
  it('a typed Absorb refusal shows its own message', async () => {
    const client = {
      absorbUpstreamUpdate: vi.fn().mockResolvedValue({ succeeded: false, refusalReason: 'could not be parsed' }),
    };
    const deps = makeDispatchDeps(client, BASELINE_BUTTON);

    await handleUnanswered(deps, [unanswered()]);

    expect(deps.showError).toHaveBeenCalledWith(
      'Could not absorb the upstream update for "ModA" — could not be parsed',
    );
    expect(deps.refreshTree).not.toHaveBeenCalled();
  });

  it('declining the dialog (defer) calls neither verb', async () => {
    const client = { keepAsMyEdit: vi.fn(), absorbUpstreamUpdate: vi.fn() };
    const deps = makeDispatchDeps(client, undefined);

    await handleUnanswered(deps, [unanswered()]);

    expect(client.keepAsMyEdit).not.toHaveBeenCalled();
    expect(client.absorbUpstreamUpdate).not.toHaveBeenCalled();
  });
});
