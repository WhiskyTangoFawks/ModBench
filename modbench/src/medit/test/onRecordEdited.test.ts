import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: {
    from: (opts: { scheme: string; path: string; query?: string }) =>
      ({ scheme: opts.scheme, path: opts.path, query: opts.query ?? '' }),
  },
}));

import { makeOnRecordEdited, broadcastToRecordPanels } from '../onRecordEdited';
import type { PluginTreeProvider } from '../PluginTreeProvider';
import type { RecordDecorationProvider } from '../RecordDecorationProvider';

function fakeTreeProvider(markResult = true): PluginTreeProvider {
  return { markWorkingTreeState: vi.fn().mockReturnValue(markResult) } as unknown as PluginTreeProvider;
}

function fakeDecorationProvider(): RecordDecorationProvider {
  return { refresh: vi.fn() } as unknown as RecordDecorationProvider;
}

// This is the actual production callback a field edit drives — driven here through a real
// call, not by hand-feeding a decoration's own accessor the way PluginsTreeComposite.test.ts's own
// compile-staleness tests do. That distinction is the point: those tests prove the decoration renders
// correctly *given* a compile-staleness answer; this proves an edit is what makes that answer change
// in the first place.
describe('makeOnRecordEdited — compile-staleness refresh (#449)', () => {
  it('calls the injected refreshCompileStale on every edit', () => {
    const refreshCompileStale = vi.fn();
    const onRecordEdited = makeOnRecordEdited(
      fakeTreeProvider(), fakeDecorationProvider(), new Set(), refreshCompileStale, vi.fn(),
    );

    onRecordEdited('000001:Test.esp', 'Test.esp', 'SomeMod');

    expect(refreshCompileStale).toHaveBeenCalledTimes(1);
  });

  it('calls refreshCompileStale even when the record-row cache has no entry for this FormKey', () => {
    // markWorkingTreeState returning false means "not cached", not "the edit didn't happen" — the
    // edit already landed server-side by the time onRecordEdited fires, so the plugin row's
    // compile-staleness decoration must not be gated on the record-row cache's own hit/miss.
    const refreshCompileStale = vi.fn();
    const onRecordEdited = makeOnRecordEdited(
      fakeTreeProvider(false), fakeDecorationProvider(), new Set(), refreshCompileStale, vi.fn(),
    );

    onRecordEdited('000001:Test.esp', 'Test.esp', 'SomeMod');

    expect(refreshCompileStale).toHaveBeenCalledTimes(1);
  });

  it('still refreshes the M/A badge decoration (#428), unchanged by the #449 addition', () => {
    const decorationProvider = fakeDecorationProvider();
    const onRecordEdited = makeOnRecordEdited(fakeTreeProvider(true), decorationProvider, new Set(), vi.fn(), vi.fn());

    onRecordEdited('000001:Test.esp', 'Test.esp', 'SomeMod');

    expect(decorationProvider.refresh).toHaveBeenCalledTimes(1);
  });

  it('broadcasts RECORD_EDITED to every open record panel', () => {
    const panels = new Set([{ webview: { postMessage: vi.fn() } }, { webview: { postMessage: vi.fn() } }]) as unknown as Set<{
      webview: { postMessage: (m: unknown) => void };
    }>;
    broadcastToRecordPanels(panels as unknown as Set<import('vscode').WebviewPanel>, { type: 'recordEdited', formKey: 'x' } as never);

    for (const panel of panels) expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: 'recordEdited', formKey: 'x' });
  });
});

// The native Source Control panel doesn't pick up a field edit's working-tree dirt on its
// own — this is the wiring that closes that gap, driven through the same real call every other
// onRecordEdited-fires test in this file uses, not by hand-feeding some other accessor directly.
describe('makeOnRecordEdited — Source Control refresh (#557)', () => {
  it('calls the injected refreshSourceControl with the edited plugin filename on every edit', () => {
    const refreshSourceControl = vi.fn();
    const onRecordEdited = makeOnRecordEdited(
      fakeTreeProvider(), fakeDecorationProvider(), new Set(), vi.fn(), refreshSourceControl,
    );

    onRecordEdited('000001:Test.esp', 'Test.esp', 'SomeMod');

    expect(refreshSourceControl).toHaveBeenCalledTimes(1);
    expect(refreshSourceControl).toHaveBeenCalledWith('Test.esp');
  });

  it('calls refreshSourceControl even when the record-row cache has no entry for this FormKey', () => {
    // Same reasoning as refreshCompileStale above: the edit already landed server-side
    // by the time this fires, so the Source Control refresh must not be gated on the record-row
    // cache's own hit/miss either.
    const refreshSourceControl = vi.fn();
    const onRecordEdited = makeOnRecordEdited(
      fakeTreeProvider(false), fakeDecorationProvider(), new Set(), vi.fn(), refreshSourceControl,
    );

    onRecordEdited('000001:Test.esp', 'Test.esp', 'SomeMod');

    expect(refreshSourceControl).toHaveBeenCalledTimes(1);
  });
});
