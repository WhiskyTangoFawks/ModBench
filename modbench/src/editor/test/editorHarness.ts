import { vi } from 'vitest';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { createEditor } from '..';
import type { ModFacts } from '../modsByOrigin';
import { createFocusedView } from '../../drivingLib/focusedView';
import { Uri } from '../../test/vscodeMock';
import { forgetVscode } from './editorVscode';

export const pickRecord = vi.fn<(...args: unknown[]) => Promise<string | null>>();

export const reporter = { report: vi.fn(), landed: vi.fn(), shownOnSurface: vi.fn(), selectionOutcome: vi.fn() };

const outputChannelDouble = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn<(message: string) => void>(), error: vi.fn() });

export const NO_MODS: ModFacts = {
  listedSourceMods: () => new Set<string>(), modOfOrigin: () => undefined, standingOf: () => ({ kind: 'enabled' }),
  onChange: () => ({ dispose: () => undefined }),
};

export function fakeLoadOrder() {
  const listeners = new Set<() => void>();
  return {
    coming: true,
    now() { return this.coming; },
    onChanged(listener: () => void) { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
    changed() { listeners.forEach((listener) => { listener(); }); },
  };
}

export function forgetEditor(): void {
  forgetVscode();
  pickRecord.mockReset();
  reporter.report.mockClear();
}

interface Registered {
  selection?: () => readonly unknown[];
  meditClient?: InMemoryMEditClient;
  recordViewIds?: readonly string[];
  modFacts?: ModFacts;
  locateRecord?: Parameters<typeof createEditor>[0]['locateRecord'];
  loadOrder?: Parameters<typeof createEditor>[0]['loadOrderComing'];
}

/** Creates the Editor with the view `test.view` selecting `selection`. */
export function register({
  selection = () => [], meditClient = new InMemoryMEditClient(),
  recordViewIds = ['test.view'], modFacts = NO_MODS, locateRecord = () => Promise.resolve(undefined),
  loadOrder = { now: () => true, onChanged: () => ({ dispose: () => undefined }) },
}: Registered = {}) {
  const focusedView = createFocusedView();
  const outputChannel = outputChannelDouble();
  const editor = createEditor({
    context: { extensionUri: Uri.file('/ext') },
    meditClient,
    loadOrderComing: loadOrder,
    outputChannel,
    reporterFor: () => reporter,
    ask: vi.fn(),
    focusedView,
    recordViewIds,
    modFacts,
    recordWriteProgressView: 'test.view',
    instance: { refresh: () => Promise.resolve(undefined) },
    sourceEditing: { applyWorkspaceChanges: () => Promise.resolve(), oneAtATime: (job) => job(), refreshSourceControlFor: () => undefined },
    locateRecord,
  });
  focusedView.follow('test.view', {
    get selection() { return selection(); },
    onDidChangeSelection: (listener: (event: { selection: readonly unknown[] }) => void) => { listener({ selection: selection() }); return { dispose: () => undefined }; },
  });
  return { editor, focusedView, outputChannel };
}
