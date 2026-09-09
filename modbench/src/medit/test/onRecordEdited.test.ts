import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: {
    from: (opts: { scheme: string; path: string; query?: string }) =>
      ({ scheme: opts.scheme, path: opts.path, query: opts.query ?? '' }),
  },
}));

import { makeOnRecordEdited } from '../onRecordEdited';
import type { PluginTreeProvider } from '../../plugins/PluginTreeProvider';
import type { RecordDecorationProvider } from '../RecordDecorationProvider';

function fakeTreeProvider(markResult = true): PluginTreeProvider {
  return { markWorkingTreeState: vi.fn().mockReturnValue(markResult) } as unknown as PluginTreeProvider;
}

function fakeDecorationProvider(): RecordDecorationProvider {
  return { refresh: vi.fn() } as unknown as RecordDecorationProvider;
}

// `hasMatchingRecords` (ADR-0035 amending ADR-0018) needs a re-derive on every edit, since a
// field edit can change which records match the active filter.
describe('makeOnRecordEdited — record-filter-match refresh', () => {
  it('calls the injected refreshMatchingPlugins on every edit', () => {
    const refreshMatchingPlugins = vi.fn();
    const onRecordEdited = makeOnRecordEdited(
      fakeTreeProvider(), fakeDecorationProvider(), refreshMatchingPlugins, vi.fn(),
    );

    onRecordEdited('000001:Test.esp', 'Test.esp', 'SomeMod');

    expect(refreshMatchingPlugins).toHaveBeenCalledTimes(1);
  });

  it('calls refreshMatchingPlugins even when the record-row cache has no entry for this FormKey', () => {
    // markWorkingTreeState returning false means "not cached", not "the edit did not happen": the
    // edit already landed server-side, so the re-derive must not be gated on the record-row cache.
    const refreshMatchingPlugins = vi.fn();
    const onRecordEdited = makeOnRecordEdited(
      fakeTreeProvider(false), fakeDecorationProvider(), refreshMatchingPlugins, vi.fn(),
    );

    onRecordEdited('000001:Test.esp', 'Test.esp', 'SomeMod');

    expect(refreshMatchingPlugins).toHaveBeenCalledTimes(1);
  });

  it('still refreshes the M/A badge decoration', () => {
    const decorationProvider = fakeDecorationProvider();
    const onRecordEdited = makeOnRecordEdited(fakeTreeProvider(true), decorationProvider, vi.fn(), vi.fn());

    onRecordEdited('000001:Test.esp', 'Test.esp', 'SomeMod');

    expect(decorationProvider.refresh).toHaveBeenCalledTimes(1);
  });
});

// The native Source Control panel does not pick up a field edit's working-tree dirt on its own;
// this is the wiring that closes that gap.
describe('makeOnRecordEdited — Source Control refresh', () => {
  it('calls the injected refreshSourceControl with the edited plugin filename on every edit', () => {
    const refreshSourceControl = vi.fn();
    const onRecordEdited = makeOnRecordEdited(
      fakeTreeProvider(), fakeDecorationProvider(), vi.fn(), refreshSourceControl,
    );

    onRecordEdited('000001:Test.esp', 'Test.esp', 'SomeMod');

    expect(refreshSourceControl).toHaveBeenCalledTimes(1);
    expect(refreshSourceControl).toHaveBeenCalledWith('Test.esp');
  });

  it('calls refreshSourceControl even when the record-row cache has no entry for this FormKey', () => {
    // Same reasoning as refreshMatchingPlugins above: the edit already landed server-side
    // by the time this fires, so the Source Control refresh must not be gated on the record-row
    // cache's own hit/miss either.
    const refreshSourceControl = vi.fn();
    const onRecordEdited = makeOnRecordEdited(
      fakeTreeProvider(false), fakeDecorationProvider(), vi.fn(), refreshSourceControl,
    );

    onRecordEdited('000001:Test.esp', 'Test.esp', 'SomeMod');

    expect(refreshSourceControl).toHaveBeenCalledTimes(1);
  });
});
