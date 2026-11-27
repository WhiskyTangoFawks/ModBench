import { vi } from 'vitest';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { createEditor } from '..';
import { createFocusedView } from '../../drivingLib/focusedView';
import { Uri } from '../../test/vscodeMock';
import { commandHandlers, editorProviders, editorVscode, fakePanel, forgetVscode, type FakePanel } from './editorVscode';

export type ModFacts = Parameters<typeof createEditor>[0]['modFacts'];

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
  reporter.report.mockClear();
  reporter.shownOnSurface.mockClear();
}

interface RecordEditorProvider {
  resolveCustomTextEditor(document: unknown, panel: unknown): Promise<void>;
}

const isRecordEditorProvider = (value: unknown): value is RecordEditorProvider =>
  typeof value === 'object' && value !== null && 'resolveCustomTextEditor' in value;

/** The URI of `fileName`, mEdit's rendering of the copy of `formKey` that A.esp in ModA holds. */
export const renderedUri = (formKey: string, fileName: string) => editorVscode.Uri.from({
  scheme: 'modbench-rendered', path: `/ModA/A.esp/${fileName}`, query: `formKey=${formKey.replace(':', '%3A')}&name=A.esp&origin=ModA`,
});

/** The value a record tab's page is handed as `window.<name>`. */
export const pageGlobal = (panel: FakePanel, name: string): unknown => {
  const html = panel.webview.html ?? '';
  const at = html.indexOf(`window.${name} = `);
  if (at < 0) return undefined;
  const start = at + `window.${name} = `.length;
  const nextAssignment = html.indexOf('; window.', start);
  return JSON.parse(html.slice(start, nextAssignment >= 0 ? nextAssignment : html.indexOf(';</script>', start)));
};

interface Registered {
  selection?: () => readonly unknown[];
  meditClient?: InMemoryMEditClient;
  recordViewIds?: readonly string[];
  modFacts?: ModFacts;
  loadOrder?: Parameters<typeof createEditor>[0]['loadOrderComing'];
}

/** Creates the Editor with the view `test.view` selecting `selection`. */
export function register({
  selection = () => [], meditClient = new InMemoryMEditClient(),
  recordViewIds = ['test.view'], modFacts = NO_MODS,
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
  });
  focusedView.follow('test.view', {
    get selection() { return selection(); },
    onDidChangeSelection: (listener: (event: { selection: readonly unknown[] }) => void) => { listener({ selection: selection() }); return { dispose: () => undefined }; },
  });
  return { editor, focusedView, outputChannel };
}

/** The Editor registered over `meditClient`, and the record tabs a test opens as VS Code does. */
export function editorOver(registered: Registered = {}) {
  const { editor, focusedView, outputChannel } = register(registered);
  const provider = editorProviders.get('modbench.record');
  if (!isRecordEditorProvider(provider)) throw new Error('no record editor registered');
  const open = (formKey: string): FakePanel => {
    const panel = fakePanel();
    void provider.resolveCustomTextEditor({ uri: renderedUri(formKey, `${formKey}.json`) }, panel);
    return panel;
  };
  const openDocument = async (uri: unknown, document: object = {}): Promise<FakePanel> => {
    const panel = fakePanel();
    await provider.resolveCustomTextEditor(Object.assign(document, { uri }), panel);
    return panel;
  };
  const openFile = (fsPath: string, document?: object): Promise<FakePanel> => openDocument({ scheme: 'file', fsPath }, document);
  const tabs = new Map<string, FakePanel>();
  const vsCodeOpensTabs = ({ resolvesAfterOpenAnswers = false } = {}) => {
    commandHandlers.set('vscode.openWith', async (uri: unknown) => {
      if (tabs.has(String(uri))) return;
      const panel = fakePanel();
      tabs.set(String(uri), panel);
      if (resolvesAfterOpenAnswers) setTimeout(() => { void provider.resolveCustomTextEditor({ uri }, panel); }, 0);
      else await provider.resolveCustomTextEditor({ uri }, panel);
    });
    return (uri: unknown) => tabs.get(String(uri));
  };
  const askedFromThePalette = () => editor.focusedRecord();
  const resolve = (document: object, panel: FakePanel): Promise<void> => provider.resolveCustomTextEditor(document, panel);
  return { editor, askedFromThePalette, open, openFile, openDocument, resolve, focusedView, outputChannel, vsCodeOpensTabs };
}
