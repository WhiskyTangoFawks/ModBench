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

// #449: this is the actual production callback a field edit drives — driven here through a real
// call, not by hand-feeding a decoration's own accessor the way PluginsTreeComposite.test.ts's own
// compile-staleness tests do. That distinction is the point: those tests prove the decoration renders
// correctly *given* a compile-staleness answer; this proves an edit is what makes that answer change
// in the first place — the exact seam #449's review found unwired.
describe('makeOnRecordEdited — compile-staleness refresh (#449)', () => {
  it('calls the injected refreshCompileStale on every edit', () => {
    const refreshCompileStale = vi.fn();
    const onRecordEdited = makeOnRecordEdited(
      fakeTreeProvider(), fakeDecorationProvider(), new Set(), refreshCompileStale,
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
      fakeTreeProvider(false), fakeDecorationProvider(), new Set(), refreshCompileStale,
    );

    onRecordEdited('000001:Test.esp', 'Test.esp', 'SomeMod');

    expect(refreshCompileStale).toHaveBeenCalledTimes(1);
  });

  it('still refreshes the M/A badge decoration (#428), unchanged by the #449 addition', () => {
    const decorationProvider = fakeDecorationProvider();
    const onRecordEdited = makeOnRecordEdited(fakeTreeProvider(true), decorationProvider, new Set(), vi.fn());

    onRecordEdited('000001:Test.esp', 'Test.esp', 'SomeMod');

    expect(decorationProvider.refresh).toHaveBeenCalledTimes(2);
  });

  it('broadcasts RECORD_EDITED to every open record panel', () => {
    const panels = new Set([{ webview: { postMessage: vi.fn() } }, { webview: { postMessage: vi.fn() } }]) as unknown as Set<{
      webview: { postMessage: (m: unknown) => void };
    }>;
    broadcastToRecordPanels(panels as unknown as Set<import('vscode').WebviewPanel>, { type: 'recordEdited', formKey: 'x' } as never);

    for (const panel of panels) expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: 'recordEdited', formKey: 'x' });
  });
});
