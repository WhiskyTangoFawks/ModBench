import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  applyEdit, commandHandlers, executed, forgetRegistrations, recordGridVscode, register, registerCustomEditorProvider, tabGroups,
} from './recordGridHarness';

vi.mock('vscode', () => recordGridVscode);

import * as vscode from 'vscode';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

function isPanel(candidate: unknown): candidate is vscode.WebviewPanel {
  return typeof candidate === 'object' && candidate !== null && 'webview' in candidate;
}
function isDocument(candidate: unknown): candidate is vscode.TextDocument {
  return typeof candidate === 'object' && candidate !== null && 'uri' in candidate;
}
function isProvider(candidate: unknown): candidate is vscode.CustomTextEditorProvider {
  return typeof candidate === 'object' && candidate !== null && 'resolveCustomTextEditor' in candidate;
}

function webviewPanel() {
  const listeners: ((message: unknown) => void)[] = [];
  const panel = {
    title: '', active: true, viewColumn: 1,
    webview: {
      html: '', options: {}, cspSource: '', asWebviewUri: () => ({ toString: () => '' }),
      postMessage: () => Promise.resolve(true),
      onDidReceiveMessage: (listener: (message: unknown) => void) => { listeners.push(listener); return { dispose: () => undefined }; },
    },
    onDidDispose: () => ({ dispose: () => undefined }),
    onDidChangeViewState: () => ({ dispose: () => undefined }),
  };
  if (!isPanel(panel)) throw new Error('not a panel');
  return { panel, tell: (message: unknown) => { for (const listener of listeners) listener(message); } };
}

beforeEach(forgetRegistrations);

describe('a file\'s tab an edit moves the file of', () => {
  const plugin = { name: 'A.esp', origin: 'ModA' };
  const NPC = '000800:A.esp';
  const FILE = '/mods/ModA/plugin-source/A.esp/Npcs/Npc.json';
  const MOVED = '/mods/ModA/plugin-source/A.esp/Npcs/Renamed.json';
  const place = { collapsedRows: ['Bounds'], collapsedColumns: ['A.esp|ModA'], focusedCell: { rowKey: 'Bounds', plugin: null }, scroll: { top: 40, left: 12 } };

  async function shownOn(provider: vscode.CustomTextEditorProvider, path: string) {
    const tab = webviewPanel();
    const document = { uri: vscode.Uri.file(path), getText: () => '{}', isDirty: false };
    if (!isDocument(document)) throw new Error('not a document');
    await provider.resolveCustomTextEditor(document, tab.panel, { isCancellationRequested: false, onCancellationRequested: vi.fn() });
    return tab;
  }

  async function editMovingTheFile() {
    const meditClient = new InMemoryMEditClient();
    meditClient.setQueryAnswer('getRecordOfFile', { formKey: NPC, plugin: plugin.name, origin: plugin.origin });
    meditClient.setQueryAnswer('getEditChanges', { applied: true, moves: [{ from: FILE, to: MOVED }], documents: [{ path: MOVED, text: '{}' }] });
    await register({ meditClient });
    const provider = registerCustomEditorProvider.mock.calls.at(-1)?.[1];
    if (!isProvider(provider)) throw new Error('no record grid registered');
    const before = await shownOn(provider, FILE);
    before.tell({ type: 'viewState', state: place });

    await commandHandlers.get('modbench.record.editField')?.(
      { formKey: NPC, plugin: plugin.name, origin: plugin.origin }, { op: 'set', path: [{ kind: 'member', name: 'EditorID' }], value: 'Renamed' });

    return { provider, meditClient };
  }

  beforeEach(() => { applyEdit.mockReset(); applyEdit.mockResolvedValue(true); });

  it('shows, where the file lands, the rows and columns collapsed, the focused cell and the scroll it had', async () => {
    const { provider } = await editMovingTheFile();

    const after = await shownOn(provider, MOVED);

    expect(after.panel.webview.html).toContain(`window.mEditViewState = ${JSON.stringify(place)};`);
  });

  it.each([
    ['refuses', () => Promise.resolve(false)],
    ['fails', () => Promise.reject(new Error('the file system said no'))],
  ])('hands nothing to a tab opened later on the path a move would have taken it to, when VS Code %s the edit', async (_, answer) => {
    applyEdit.mockImplementation(answer);
    const { provider, meditClient } = await editMovingTheFile();

    const later = await shownOn(provider, MOVED);

    expect(later.panel.webview.html).not.toContain('mEditViewState');
    expect(meditClient.calls.filter(({ method, args }) => method === 'getRecordOfFile' && args[0] === MOVED)).toHaveLength(1);
  });

});

describe('a file mEdit answers holds no record', () => {
  const METADATA = '/mods/ModA/plugin-source/A.esp/Cells/GroupRecordData.json';
  const uri = vscode.Uri.file(METADATA);
  const reopened = () => executed().filter(([id]) => id === 'vscode.openWith');
  const inStead = { viewColumn: 1, preview: true, preserveFocus: true, background: true };

  async function opened(meditClient: InMemoryMEditClient, inAGroup = true) {
    const warn = vi.fn();
    await register({ meditClient, outputChannel: { debug: vi.fn(), info: vi.fn(), warn } });
    const provider = registerCustomEditorProvider.mock.calls.at(-1)?.[1];
    const document = { uri, getText: () => '{}', isDirty: false };
    const { panel } = webviewPanel();
    const group = { viewColumn: 1, tabs: [] as unknown[] };
    group.tabs.push({ group, input: new vscode.TabInputCustom(uri, 'modbench.record'), isActive: true, isPreview: true });
    tabGroups.splice(0, tabGroups.length, ...(inAGroup ? [group] : []));
    if (!isProvider(provider) || !isDocument(document)) throw new Error('no record grid registered');

    await provider.resolveCustomTextEditor(document, panel, { isCancellationRequested: false, onCancellationRequested: vi.fn() });
    return { panel, warn };
  }

  function answeringNone(): InMemoryMEditClient {
    const meditClient = new InMemoryMEditClient();
    meditClient.setQueryAnswer('getRecordOfFile', null);
    return meditClient;
  }

  it('reopens in the text editor in its tab\'s stead, drawing no grid', async () => {
    const { panel } = await opened(answeringNone());

    expect(reopened()).toEqual([['vscode.openWith', uri, 'default', inStead]]);
    expect(panel.webview.html).toBe('');
  });

  it('answered once mEdit holds the load order, reopens without taking the focus', async () => {
    const meditClient = answeringNone();
    meditClient.setQueryFailureOnce('getRecordOfFile', new Error('mEdit has not started'));
    await opened(meditClient);

    meditClient.emit({
      kind: 'load-order-status', plugin: '', origin: '', keys: [], sequence: 0,
      loadOrderStatus: { state: 'Ready', totalPlugins: 1, activePlugins: 1, indexedPlugins: [], conflictsComputed: false, failures: [], version: 1 },
    });

    await vi.waitFor(() => expect(reopened()).toEqual([['vscode.openWith', uri, 'default', inStead]]));
  });

  it('stays, saying why in the Output, when VS Code shows its tab in no group', async () => {
    const { warn } = await opened(answeringNone(), false);

    expect(warn).toHaveBeenCalledWith(`${METADATA} holds no record, but VS Code shows its tab in no group to reopen in the text editor.`);
    expect(reopened()).toEqual([]);
  });
});

describe('a child record\'s tab, on mEdit\'s report of its record', () => {
  const plugin = { name: 'A.esp', origin: 'ModA' };
  const PLACED = '000801:A.esp';
  const CELL_FILE = '/mods/ModA/plugin-source/A.esp/Cells/Cell.json';
  const OTHER_CELL_FILE = '/mods/ModA/plugin-source/A.esp/Cells/Other.json';
  const query = `formKey=${encodeURIComponent(PLACED)}&name=${plugin.name}&origin=${plugin.origin}`;
  const childUri = { scheme: 'modbench-child-record', path: CELL_FILE, query, toString: () => `modbench-child-record:${CELL_FILE}?${query}` };
  const changed = { kind: 'rows-changed' as const, plugin: plugin.name, origin: plugin.origin, keys: [PLACED], sequence: 1 };
  const opened = () => executed().filter(([id]) => id === 'vscode.openWith').map(([, uri]) => uri);

  function isUri(candidate: unknown): candidate is vscode.Uri {
    return typeof candidate === 'object' && candidate !== null && 'scheme' in candidate;
  }

  async function showChild(provider: vscode.CustomTextEditorProvider, formKey: string) {
    const childQuery = `formKey=${encodeURIComponent(formKey)}&name=${plugin.name}&origin=${plugin.origin}`;
    const uri = { scheme: 'modbench-child-record', path: CELL_FILE, query: childQuery, toString: () => `modbench-child-record:${CELL_FILE}?${childQuery}` };
    const document = { uri, getText: () => '{}', isDirty: false };
    const disposed: (() => void)[] = [];
    const panel = {
      title: '', active: true, viewColumn: 1,
      webview: {
        html: '', options: {}, cspSource: '', asWebviewUri: () => ({ toString: () => '' }), postMessage: () => Promise.resolve(true),
        onDidReceiveMessage: () => ({ dispose: () => undefined }),
      },
      onDidDispose: (listener: () => void) => { disposed.push(listener); return { dispose: () => undefined }; },
      onDidChangeViewState: () => ({ dispose: () => undefined }),
    };
    if (!isDocument(document) || !isPanel(panel)) throw new Error('not a child record\'s tab');
    await provider.resolveCustomTextEditor(document, panel, { isCancellationRequested: false, onCancellationRequested: vi.fn() });
    return { close: () => { disposed.forEach((listener) => { listener(); }); } };
  }

  async function childTabShown(meditClient: InMemoryMEditClient, inAGroup = true) {
    const warn = vi.fn();
    await register({ meditClient, outputChannel: { debug: vi.fn(), info: vi.fn(), warn } });
    const provider = registerCustomEditorProvider.mock.calls.at(-1)?.[1];
    if (!isProvider(provider) || !isUri(childUri)) throw new Error('no record grid registered');
    await showChild(provider, PLACED);
    const group = { viewColumn: 1, tabs: [] as unknown[] };
    group.tabs.push({ group, input: new vscode.TabInputCustom(childUri, 'modbench.record'), isActive: true, isPreview: false });
    tabGroups.splice(0, tabGroups.length, ...(inAGroup ? [group] : []));
    return { warn, provider };
  }

  it('follows it again for a report that arrives while it follows the one before', async () => {
    const meditClient = new InMemoryMEditClient();
    let answerFirst: (document: { kind: 'ContainersFile'; location: string }) => void = () => undefined;
    meditClient.setQueryAnswerOnce('getCopyDocument', new Promise<{ kind: 'ContainersFile'; location: string }>((resolve) => { answerFirst = resolve; }));
    meditClient.setQueryAnswer('getCopyDocument', { kind: 'ContainersFile', location: OTHER_CELL_FILE });
    await childTabShown(meditClient);

    meditClient.emit(changed);
    meditClient.emit({ ...changed, sequence: 2 });
    answerFirst({ kind: 'ContainersFile', location: CELL_FILE });

    await vi.waitFor(() => expect(opened()).toEqual([`modbench-child-record:${OTHER_CELL_FILE}?${query}`]));
    expect(meditClient.calls.filter(({ method }) => method === 'getCopyDocument')).toHaveLength(2);
  });

  it('follows no tab closed while it follows the one before', async () => {
    const meditClient = new InMemoryMEditClient();
    let answerFirst: (document: { kind: 'ContainersFile'; location: string }) => void = () => undefined;
    meditClient.setQueryAnswerOnce('getCopyDocument', new Promise<{ kind: 'ContainersFile'; location: string }>((resolve) => { answerFirst = resolve; }));
    meditClient.setQueryAnswer('getCopyDocument', { kind: 'ContainersFile', location: OTHER_CELL_FILE });
    const { warn, provider } = await childTabShown(meditClient);
    const closing = await showChild(provider, '000802:A.esp');

    meditClient.emit(changed);
    closing.close();
    meditClient.emit({ ...changed, sequence: 2 });
    answerFirst({ kind: 'ContainersFile', location: CELL_FILE });

    await vi.waitFor(() => expect(opened()).toEqual([`modbench-child-record:${OTHER_CELL_FILE}?${query}`]));
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays, saying why in the Output, when mEdit names no document carrying its record', async () => {
    const meditClient = new InMemoryMEditClient();
    meditClient.setQueryAnswer('getCopyDocument', null);
    const { warn } = await childTabShown(meditClient);

    meditClient.emit(changed);

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      `${PLACED}'s tab stays on modbench-child-record:${CELL_FILE}?${query}: A.esp (ModA) holds no ${PLACED}.`));
    expect(opened()).toEqual([]);
  });

  it('stays, saying why in the Output, when VS Code shows it in no group', async () => {
    const meditClient = new InMemoryMEditClient();
    meditClient.setQueryAnswer('getCopyDocument', { kind: 'ContainersFile', location: OTHER_CELL_FILE });
    const { warn } = await childTabShown(meditClient, false);

    meditClient.emit(changed);

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      `${PLACED}'s tab stays on modbench-child-record:${CELL_FILE}?${query}: VS Code shows the tab in no group.`));
    expect(opened()).toEqual([]);
  });
});
