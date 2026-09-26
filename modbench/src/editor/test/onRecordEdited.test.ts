import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: {
    from: (opts: { scheme: string; path: string; query?: string }) =>
      ({ scheme: opts.scheme, path: opts.path, query: opts.query ?? '' }),
  },
}));

import { makeOnRecordEdited, type RecordTreeSync } from '../onRecordEdited';
import type { RecordDecorationProvider } from '../RecordDecorationProvider';

function fakeTreeProvider(markResult = true): RecordTreeSync {
  return {
    markWorkingTreeState: vi.fn().mockReturnValue(markResult),
    workingTreeStateOf: vi.fn(),
  };
}

function fakeDecorationProvider(): Pick<RecordDecorationProvider, 'refresh'> {
  return { refresh: vi.fn() };
}

describe('makeOnRecordEdited — the M/A badge', () => {
  it('refreshes the M/A badge decoration', () => {
    const decorationProvider = fakeDecorationProvider();
    const onRecordEdited = makeOnRecordEdited(fakeTreeProvider(true), decorationProvider, vi.fn());

    onRecordEdited('000001:Test.esp', 'Test.esp', 'SomeMod');

    expect(decorationProvider.refresh).toHaveBeenCalledTimes(1);
  });
});

// The native Source Control panel does not pick up a field edit's working-tree dirt on its own;
// this is the wiring that closes that gap.
describe('makeOnRecordEdited — Source Control refresh', () => {
  it('calls the injected refreshSourceControl with the edited plugin on every edit', () => {
    const refreshSourceControl = vi.fn();
    const onRecordEdited = makeOnRecordEdited(
      fakeTreeProvider(), fakeDecorationProvider(), refreshSourceControl,
    );

    onRecordEdited('000001:Test.esp', 'Test.esp', 'SomeMod');

    expect(refreshSourceControl).toHaveBeenCalledTimes(1);
    expect(refreshSourceControl).toHaveBeenCalledWith('Test.esp', 'SomeMod');
  });

  it('calls refreshSourceControl even when the record-row cache has no entry for this FormKey', () => {
    // markWorkingTreeState returning false means "not cached", not "the edit did not happen": the
    // edit already landed server-side, so the Source Control refresh is not gated on the cache.
    const refreshSourceControl = vi.fn();
    const onRecordEdited = makeOnRecordEdited(
      fakeTreeProvider(false), fakeDecorationProvider(), refreshSourceControl,
    );

    onRecordEdited('000001:Test.esp', 'Test.esp', 'SomeMod');

    expect(refreshSourceControl).toHaveBeenCalledTimes(1);
  });
});
