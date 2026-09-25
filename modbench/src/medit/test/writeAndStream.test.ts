import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: {
    from: (opts: { scheme: string; path: string; query?: string }) =>
      ({ scheme: opts.scheme, path: opts.path, query: opts.query ?? '' }),
  },
}));

import { makeOnRecordEdited, type RecordTreeSync } from '../../editor/onRecordEdited';
import type { RecordDecorationProvider } from '../../editor/RecordDecorationProvider';
import { subscribeRecordPanelsToNotifications } from '../notificationWiring';
import { InMemoryMEditClient } from '../../client';

function fakeDecorationProvider(): Pick<RecordDecorationProvider, 'refresh'> {
  return { refresh: vi.fn() };
}

function fakePanel(): { webview: { postMessage: ReturnType<typeof vi.fn> } } {
  return { webview: { postMessage: vi.fn() } };
}

function fakeActiveRecordTracker() {
  const formKeys = new Map<unknown, string>();
  return {
    setFormKey(panel: unknown, formKey: string) { formKeys.set(panel, formKey); },
    formKeyOf(panel: unknown) { return formKeys.get(panel); },
  };
}

// ADR-0015 invariant 3: the write's own callback is silent; the stream is the panel's only
// re-read trigger. Spans the port's notification wiring and Editor's own write callback.
describe('a write and the stream, together (ADR-0015 invariant 3)', () => {
  it('after a write, the panel re-reads exactly once, on rows-changed', () => {
    const meditClient = new InMemoryMEditClient();
    const panel = fakePanel();
    const recordPanels = new Set([panel]);
    const tracker = fakeActiveRecordTracker();
    tracker.setFormKey(panel, '000001:Test.esp');
    subscribeRecordPanelsToNotifications(meditClient, recordPanels, tracker, { holds: () => false, waitingFor: () => undefined, release: () => false });

    const treeSync: RecordTreeSync = { refresh: vi.fn(), workingTreeStateOf: vi.fn(), markWorkingTreeState: vi.fn().mockReturnValue(false) };
    const decorationProvider = fakeDecorationProvider();
    const onRecordEdited = makeOnRecordEdited(treeSync, decorationProvider, vi.fn(), vi.fn());

    onRecordEdited('000001:Test.esp', 'Test.esp', 'ModA');
    expect(panel.webview.postMessage).not.toHaveBeenCalled();

    meditClient.emit({ kind: 'rows-changed', plugin: 'Test.esp', origin: 'ModA', keys: ['000001:Test.esp'], sequence: 1 });

    expect(panel.webview.postMessage).toHaveBeenCalledTimes(1);
    expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: 'loadRecord', formKey: '000001:Test.esp' });
  });
});
