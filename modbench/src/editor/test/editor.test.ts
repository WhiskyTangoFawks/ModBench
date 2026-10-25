import { modOfOriginIn } from '../../test/mo2/instanceValueFixture';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReferencesViewInput } from '../referencesView';
import {
  commandHandlers, contextKeys, disk, documentChanges, editorProviderDisposals, editorProviderOptions, editorProviders, editorVscode,
  executeCommand, executed, fakePanel, fileSystems, openedDocuments, pickers, referencesView, type FakePanel,
} from './editorVscode';

vi.mock('vscode', () => editorVscode);

import * as vscode from 'vscode';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { ModFacts } from '../modsByOrigin';
import { fakeLoadOrder, forgetEditor, NO_MODS, register, reporter } from './editorHarness';
import { WEBVIEW_TO_EXTENSION } from '../../wire/messages';
import { present } from '../../ports/present';
import { comparisonOf } from '../../test/comparison';
import { loadOrderStatusEventFixture, notificationEventFixture, pluginMetadataFixture } from '../../client/test/fixtures';
import { DATA_DIRECTORY_ORIGIN, samePluginAddress } from '../../wire/pluginAddress';
import { columnKey } from '../../wire/columnKey';

const COPY_PLUGIN = { name: 'A.esp', origin: 'ModA' };
const renderedUri = (formKey: string, fileName: string) => vscode.Uri.from({
  scheme: 'modbench-rendered', path: `/ModA/A.esp/${fileName}`, query: `formKey=${formKey.replace(':', '%3A')}&name=A.esp&origin=ModA`,
});
const isShowColumns = (message: unknown) => typeof message === 'object' && message !== null && 'type' in message && message.type === 'showColumns';
const aMacrotask = () => new Promise((resolve) => setTimeout(resolve, 0));
const readAnswered = (tab: FakePanel, requestId = 'r1') => vi.waitFor(() => expect(tab.webview.postMessage).toHaveBeenCalledWith(
  expect.objectContaining({ type: 'recordLoadAnswered', requestId })));

interface RecordEditorProvider {
  resolveCustomTextEditor(document: unknown, panel: unknown): Promise<void>;
}

const isRecordEditorProvider = (value: unknown): value is RecordEditorProvider =>
  typeof value === 'object' && value !== null && 'resolveCustomTextEditor' in value;

const inItsDocument = () => new vscode.Location(vscode.Uri.file('/its/document.json'), new vscode.Position(3, 15));

let loadOrder = fakeLoadOrder();

function makeEditor(
  client = new InMemoryMEditClient(), recordViewIds = [] as readonly string[], modFacts = NO_MODS,
  locateRecord = vi.fn((_record: object) => Promise.resolve<vscode.Location | { refused: string } | undefined>(inItsDocument())),
) {
  const { editor, focusedView, outputChannel } = register({ meditClient: client, recordViewIds, modFacts, locateRecord, loadOrder });
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
  return { editor, open, openFile, openDocument, focusedView, outputChannel, vsCodeOpensTabs };
}

beforeEach(() => {
  forgetEditor();
  loadOrder = fakeLoadOrder();
});

const askReferencedBy = async (...args: unknown[]): Promise<ReferencesViewInput | undefined> => {
  const shown = referencesView.inputs.length;
  await commandHandlers.get('modbench.record.referencedBy')?.(...args);
  return referencesView.inputs.slice(shown).at(-1);
};

const askedFromThePalette = async () => {
  const [inputs, pickersBefore] = [referencesView.inputs.length, pickers.shown];
  await askReferencedBy();
  return { listed: referencesView.inputs.slice(inputs).map((input) => input.title), picked: pickers.shown - pickersBefore };
};
const listing = (record: string) => ({ listed: [`Referenced By: ${record}`], picked: 0 });
const PICKED = { listed: [], picked: 1 };

const pageGlobal = (panel: FakePanel, name: string): unknown => {
  const html = panel.webview.html ?? '';
  const at = html.indexOf(`window.${name} = `);
  if (at < 0) return undefined;
  const start = at + `window.${name} = `.length;
  const nextAssignment = html.indexOf('; window.', start);
  return JSON.parse(html.slice(start, nextAssignment >= 0 ? nextAssignment : html.indexOf(';</script>', start)));
};

const comparisonsAsked = (client: InMemoryMEditClient) =>
  client.calls.filter(({ method }) => method === 'getComparison').map(({ args }) => args);

const changeDocument = (change: { document: unknown; contentChanges: unknown[] }) => {
  documentChanges.forEach((listener) => { listener(change); });
};

const activeA = [pluginMetadataFixture({ name: 'A.esp', origin: 'ModA', inLoadOrder: true })];
const inactiveA = [pluginMetadataFixture({ name: 'A.esp', origin: 'ModA', loadOrderIndex: null, inLoadOrder: false })];

const opened = () => executed().filter(([id]) => id === 'vscode.openWith').map(([, uri]) => uri);

describe('Referenced By from the palette asks about the record tab in focus', () => {
  function palette() {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', []);
    client.setQueryAnswer('getComparison', null);
    return makeEditor(client);
  }

  it('the record of the tab opened, then of the tab focused', async () => {
    const { open } = palette();

    const first = open('000801:A.esp');
    expect(await askedFromThePalette()).toEqual(listing('000801:A.esp'));
    open('000802:A.esp');
    expect(await askedFromThePalette()).toEqual(listing('000802:A.esp'));
    first.focus();
    expect(await askedFromThePalette()).toEqual(listing('000801:A.esp'));
  });

  it('asks with the record picker once the tab in focus closes, though other record tabs stay open, until another is focused', async () => {
    const { open } = palette();
    const first = open('000801:A.esp');
    const second = open('000802:A.esp');
    second.focus();
    first.focus();

    first.close();
    expect(await askedFromThePalette()).toEqual(PICKED);
    second.focus();
    expect(await askedFromThePalette()).toEqual(listing('000802:A.esp'));
  });

  it('keeps the record in focus when a tab out of focus closes', async () => {
    const { open } = palette();
    const first = open('000801:A.esp');
    open('000802:A.esp');

    first.close();

    expect(await askedFromThePalette()).toEqual(listing('000802:A.esp'));
  });

  it('asks with the record picker with no record tab open', async () => {
    palette();

    expect(await askedFromThePalette()).toEqual(PICKED);
  });

  it('names the new FormKey for the tab in focus when an edit of its FormID moves it, and keeps the record in focus when another tab moves', async () => {
    const [OLD, MOVED, OTHER] = ['000800:A.esp', '000900:A.esp', '000802:A.esp'];
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', []);
    client.setQueryAnswer('getComparison', null);
    client.setQueryAnswer('getPlugins', activeA);
    client.setQueryAnswer('getCopyDocument', { kind: 'OwnFile', location: '/source/ModA/plugin-source/A.esp/Npcs/Npc.json' });
    client.setQueryAnswer('getRecordOfFile', { formKey: OLD, plugin: COPY_PLUGIN });
    client.setQueryAnswer('getEditChanges', { applied: true, newFormKey: MOVED, moves: [], deletions: [], documents: [] });
    const { open } = makeEditor(client);
    const moving = open(OLD);
    open(OTHER);

    await commandHandlers.get('modbench.record.editField')?.(
      { formKey: OLD, plugin: COPY_PLUGIN.name, origin: COPY_PLUGIN.origin }, { op: 'set', path: [{ kind: 'member', name: 'FormID' }], value: 'x' });
    expect(await askedFromThePalette()).toEqual(listing(OTHER));

    moving.focus();
    expect(await askedFromThePalette()).toEqual(listing(MOVED));
  });
});

describe('Referenced By on a record, answered in VS Code\'s References view', () => {
  const GUN = '000801:A.esp';
  const recordRow = { argument: { kind: 'record', formKey: GUN, plugin: COPY_PLUGIN } };
  function asking() {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getComparison', comparisonOf(GUN, [{ plugin: 'A.esp', isWinner: true, editorId: 'Gun' }]));
    client.setQueryAnswer('getPlugins', []);
    client.setQueryAnswer('getReferences', [{
      formKey: '000900:A.esp', plugin: 'A.esp', origin: 'ModA', fieldPath: 'Keywords[0]', recordType: 'weap', recordTypeName: 'Weapon', editorId: 'Rifle',
    }]);
    const anchor = inItsDocument();
    const locateRecord = vi.fn((_record: object) => Promise.resolve<vscode.Location | { refused: string } | undefined>(anchor));
    makeEditor(client, [], NO_MODS, locateRecord);
    const referencesAsked = () => client.calls.filter(({ method }) => method === 'getReferences').map(({ args }) => args);
    return { client, anchor, locateRecord, referencesAsked };
  }
  const rowsOf = async (input: ReferencesViewInput | undefined) => (await present(input, 'the list shown').resolve()).provider.getChildren();
  const labelsOf = async (input: ReferencesViewInput | undefined) => (await rowsOf(input)).map((row) => row.label);
  const idsOf = async (input: ReferencesViewInput | undefined) => (await rowsOf(input)).map((row) => row.id);

  it('shows the clicked record\'s list, titled by its EditorID and anchored at its FormKey in that copy\'s document', async () => {
    const { anchor, locateRecord } = asking();

    const input = await askReferencedBy(recordRow, [recordRow]);

    expect(input?.title).toBe('Referenced By: Gun');
    expect(locateRecord).toHaveBeenCalledWith({ kind: 'record', formKey: GUN, plugin: COPY_PLUGIN });
    expect(input?.location).toBe(anchor);
    expect(await labelsOf(input)).toEqual(['Rifle']);
  });

  it('reads the list only when the view resolves it, and again on each refresh, wherever the view moves its anchor', async () => {
    const { referencesAsked } = asking();
    const input = present(await askReferencedBy(recordRow), 'the list shown');
    expect(referencesAsked()).toEqual([]);

    await input.resolve();
    const moved = input.with(new vscode.Location(vscode.Uri.file('/its/document.json'), new vscode.Position(9, 15)));
    await moved.resolve();

    expect(referencesAsked()).toEqual([[GUN], [GUN]]);
    expect(moved.title).toBe(input.title);
  });

  it('gives each list its own rows, so the same record asked about again shows collapsed, and the view\'s refresh keeps what was expanded', async () => {
    asking();
    const first = present(await askReferencedBy(recordRow), 'the first list');
    const again = present(await askReferencedBy(recordRow), 'the list asked for again');
    const refreshed = first.with(new vscode.Location(vscode.Uri.file('/its/document.json'), new vscode.Position(9, 15)));

    expect(await idsOf(again)).not.toEqual(await idsOf(first));
    expect(await idsOf(refreshed)).toEqual(await idsOf(first));
  });

  it('is refused, naming the built-in extension it needs, while VS Code\'s References view is disabled, before any record is asked for', async () => {
    asking();
    referencesView.enabled = false;

    await askReferencedBy();

    expect(pickers.shown).toBe(0);
    expect(reporter.report.mock.calls).toEqual([['error', 'Referenced By needs VS Code\'s built-in Reference Search View.', 'Enable the extension vscode.references-view.']]);
  });

  it('is refused for what names no record', async () => {
    asking();

    expect(await askReferencedBy({ argument: { kind: 'mod', name: 'ModA' } })).toBeUndefined();
    expect(reporter.report.mock.calls).toEqual([['error', 'Could not list what references a record.', 'What was given names no record.']]);
  });

  it.each([
    [{ refused: 'A.esp (ModA) holds no 000801:A.esp.' }, 'A.esp (ModA) holds no 000801:A.esp.'],
    [undefined, 'No active plugin holds 000801:A.esp.'],
  ])('is refused, saying why, when the record has no place in a document: %j', async (located, why) => {
    const { locateRecord } = asking();
    locateRecord.mockResolvedValue(located);

    expect(await askReferencedBy(recordRow)).toBeUndefined();
    expect(reporter.report.mock.calls).toEqual([['error', `Could not list what references ${GUN}.`, why]]);
  });
});

describe('the focused cell of the record tab in focus', () => {
  it('publishes its keys, enters the record grid as the focused view and is what copy value copies from it', () => {
    const { editor, open, focusedView } = makeEditor();
    const panel = open('000801:A.esp');

    panel.receive({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: { webviewSection: 'field', copyText: 'Iron' }, entered: true });

    expect(contextKeys.get('modbench.record.focusedCellSection')).toBe('field');
    expect(focusedView.id()).toBe('modbench.recordGrid');
    expect(editor.copyValue.map(({ text }) => text({ view: 'modbench.recordGrid' }, undefined))).toEqual(['Iron', undefined]);
  });

  const cell = (webviewSection: string) => ({ webviewSection });
  const focusedSection = () => contextKeys.get('modbench.record.focusedCellSection');

  it('is the cell of the tab in focus, whichever tab reported one, and follows the focus', () => {
    const { open } = makeEditor();
    const [first, second] = [open('000801:A.esp'), open('000802:A.esp')];
    first.receive({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: cell('first'), entered: false });
    expect(focusedSection()).toBeUndefined();

    second.receive({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: cell('second'), entered: false });
    expect(focusedSection()).toBe('second');
    first.focus();
    expect(focusedSection()).toBe('first');
  });

  it('is gone with the tab that held it', () => {
    const { open } = makeEditor();
    const tab = open('000801:A.esp');
    tab.receive({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: cell('field'), entered: false });

    tab.close();

    expect(focusedSection()).toBeUndefined();
  });

  it('enters the record grid as the focused view when a tab gains the focus, and not when a re-read refreshes its cell', () => {
    const { open, focusedView } = makeEditor();
    const tab = open('000801:A.esp');
    expect(focusedView.id()).toBe('modbench.recordGrid');
    focusedView.enter('modbench.modList');

    tab.receive({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: cell('field'), entered: false });
    expect(focusedView.id()).toBe('modbench.modList');
    tab.focus();
    expect(focusedView.id()).toBe('modbench.recordGrid');
  });

});

const conflictsComputedTick = loadOrderStatusEventFixture();
const reconcilingTick = loadOrderStatusEventFixture({ conflictsComputed: false });

describe('conflicts computed', () => {
  it('has every open record tab read its record again', () => {
    const client = new InMemoryMEditClient();
    const { open } = makeEditor(client);
    const tabs = [open('000801:A.esp'), open('000802:A.esp')];

    client.emit(conflictsComputedTick);

    expect(tabs.map((tab) => tab.webview.postMessage.mock.calls)).toEqual([
      [[{ type: 'loadRecord', formKey: '000801:A.esp' }]],
      [[{ type: 'loadRecord', formKey: '000802:A.esp' }]],
    ]);
  });
});

describe('an edit of a FormID, fired with no panel', () => {
  const [OLD, MOVED] = ['000800:A.esp', '000900:A.esp'];

  it('moves the tab showing the record to its new FormKey', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', []);
    client.setQueryAnswer('getComparison', null);
    client.setQueryAnswer('getRecordsComparison', { compare: null, missing: [{ formKey: OLD, plugin: COPY_PLUGIN, reason: 'RecordGone', message: 'gone' }] });
    client.setQueryAnswer('getCopyDocument', { kind: 'OwnFile', location: '/source/ModA/plugin-source/A.esp/Npcs/Npc.json' });
    client.setQueryAnswer('getRecordOfFile', { formKey: OLD, plugin: COPY_PLUGIN });
    client.setQueryAnswer('getEditChanges', { applied: true, newFormKey: MOVED, moves: [], deletions: [], documents: [] });
    const { open } = makeEditor(client);
    const tab = open(OLD);

    await commandHandlers.get('modbench.record.editField')?.(
      { formKey: OLD, plugin: COPY_PLUGIN.name, origin: COPY_PLUGIN.origin }, { op: 'set', path: [{ kind: 'member', name: 'FormID' }], value: 'x' });
    client.emit(notificationEventFixture({ kind: 'rows-changed', plugin: 'A.esp', origin: 'ModA', keys: [OLD, MOVED], sequence: 2 }));

    expect(tab.webview.postMessage.mock.calls).toEqual([[{ type: 'loadRecord', formKey: MOVED }]]);
  });
});

describe('a record gesture from the palette', () => {
  it('opens the records selected in a view the Editor is handed, while that view has the focus', async () => {
    const plugins = { selection: [{ argument: { kind: 'record', plugin: { name: 'A.esp', origin: 'ModA' }, formKey: '000803:A.esp' } }], onDidChangeSelection: (listener: (event: { selection: unknown[] }) => void) => { listener({ selection: [] }); return { dispose: () => undefined }; } };
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getRecordOwner', COPY_PLUGIN);
    client.setQueryAnswer('getCopyDocument', { kind: 'Rendered', location: 'Placed.json' });
    const { focusedView } = makeEditor(client, ['modbench.pluginListTree']);
    focusedView.follow('modbench.pluginListTree', plugins);

    await commandHandlers.get('modbench.record.open')?.();

    expect(contextKeys.get('modbench.record.selectionIn')).toBe('modbench.pluginListTree');
    expect(opened()).toEqual([renderedUri('000803:A.esp', 'Placed.json')]);
  });
});

describe('the Editor\'s file systems', () => {
  const FORM_KEY = '000803:A.esp';
  const CELL_FILE = '/source/ModA/plugin-source/A.esp/Cells/Cell.json';
  const plugin = { name: 'A.esp', origin: 'ModA' };

  interface ReadableFileSystem { readFile(uri: unknown): Promise<Uint8Array> }
  const isReadable = (value: unknown): value is ReadableFileSystem =>
    typeof value === 'object' && value !== null && 'readFile' in value && typeof value.readFile === 'function';

  const hasScheme = (value: unknown): value is { scheme: string } =>
    typeof value === 'object' && value !== null && 'scheme' in value && typeof value.scheme === 'string';

  const documentIn = (uri: unknown): { scheme: string } => {
    if (!hasScheme(uri)) throw new Error('no document opened');
    return uri;
  };

  async function readThrough(uri: { scheme: string }): Promise<string> {
    const files = fileSystems.get(uri.scheme);
    if (!isReadable(files)) throw new Error(`no file system registered on ${uri.scheme}`);
    return new TextDecoder().decode(await files.readFile(uri));
  }

  const fieldClient = () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getComparison', {
      ...comparisonOf(FORM_KEY, [{ plugin: 'A.esp', origin: 'ModA', isWinner: true }]),
      diffs: [{
        fieldName: 'Description', values: { [columnKey(plugin)]: 'a long description' },
        winnerColumn: '', cellStates: {}, conflictAll: 'NoConflict',
      }],
    });
    return client;
  };

  async function openedField(): Promise<{ scheme: string }> {
    makeEditor(fieldClient());
    await commandHandlers.get('modbench.record.openFieldValue')?.({
      webviewSection: 'stringValue', formKey: FORM_KEY, plugin: plugin.name, origin: plugin.origin, recordLabel: 'Cell [000803:A.esp]',
      fieldName: 'Description', value: 'a long description', readOnly: false, path: [{ kind: 'member', name: 'Description' }],
    });
    return documentIn(openedDocuments.at(-1));
  }

  it('read a field value opened from its cell', async () => {
    expect(await readThrough(await openedField())).toBe('a long description');
  });

  it('read a child record through its container\'s file', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getCopyDocument', { kind: 'ContainersFile', location: CELL_FILE });
    client.setQueryAnswer('getRecordOfFile', null);
    makeEditor(client);
    disk.set(CELL_FILE, '{ "EditorID": "Cell" }');
    await commandHandlers.get('modbench.record.open')?.({ argument: { kind: 'record', formKey: FORM_KEY, plugin } });
    const [uri] = opened();

    expect(await readThrough(documentIn(uri))).toBe('{ "EditorID": "Cell" }');
  });
});

describe('a record file\'s tab', () => {
  const GUN = '000801:A.esp';
  const FILE = '/source/ModA/plugin-source/A.esp/Weapons/Gun.json';
  const holding = (formKey: string) => ({ formKey, plugin: { name: 'A.esp', origin: 'ModA' } });
  function fileClient(): InMemoryMEditClient {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', []);
    client.setQueryAnswer('getComparison', comparisonOf(GUN, [{ plugin: 'A.esp', isWinner: true, editorId: 'Gun' }]));
    client.setQueryAnswer('getPlugins', []);
    return client;
  }

  it('shows the record mEdit says the file holds, asked about by Referenced By and read again as any record tab is', async () => {
    const client = fileClient();
    client.setQueryAnswer('getRecordOfFile', holding(GUN));
    const { openFile } = makeEditor(client);

    const tab = await openFile(FILE);

    expect(client.calls).toContainEqual({ method: 'getRecordOfFile', args: [FILE] });
    expect(pageGlobal(tab, 'mEditFormKey')).toBe(GUN);
    expect(await askedFromThePalette()).toEqual(listing('Gun'));
    client.emit(conflictsComputedTick);
    expect(tab.webview.postMessage.mock.calls).toEqual([[{ type: 'loadRecord', formKey: GUN }]]);
  });

  it('keeps the file\'s name as its title once its read is answered', async () => {
    const client = fileClient();
    client.setQueryAnswer('getRecordOfFile', holding(GUN));
    const { openFile } = makeEditor(client);
    const tab = await openFile(FILE);
    tab.title = 'Gun.json';

    tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: GUN, columns: [] });
    await readAnswered(tab);

    expect(tab.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'recordLoadAnswered', ok: true }));
    expect(tab.title).toBe('Gun.json');
  });

  it('shows "Failed to load:" and mEdit\'s reason when mEdit refuses the file, and adds no Output line of its own', async () => {
    const client = fileClient();
    const why = `${FILE} declares no FormKey, so it is no record's document.`;
    client.setQueryFailure('getRecordOfFile', { failed: 'refused', refusal: why });
    const { openFile, outputChannel } = makeEditor(client);

    const tab = await openFile(FILE);

    expect(pageGlobal(tab, 'mEditLoadError')).toEqual({ failed: 'refused', refusal: why });
    expect(pageGlobal(tab, 'mEditFormKey')).toBeUndefined();
    expect(outputChannel.warn).not.toHaveBeenCalled();
  });

  it('shows the empty panel, and no line in the Output, when mEdit refuses while a load order is on its way, then the record once it arrives', async () => {
    const client = fileClient();
    client.setQueryFailureOnce('getRecordOfFile', { failed: 'no-load-order', refusal: 'No load order has been received.' });
    client.setQueryAnswer('getRecordOfFile', holding(GUN));
    const { openFile, outputChannel } = makeEditor(client);

    const tab = await openFile(FILE);

    expect(pageGlobal(tab, 'mEditLoadError')).toBeUndefined();
    expect(outputChannel.warn).not.toHaveBeenCalled();

    client.emit(reconcilingTick);

    await vi.waitFor(() => expect(pageGlobal(tab, 'mEditFormKey')).toBe(GUN));
  });

  it('shows "Failed to load:" and adds no Output line of its own when mEdit refuses and no load order is on its way', async () => {
    loadOrder.coming = false;
    const client = fileClient();
    const refusal = { failed: 'no-load-order', refusal: 'No load order has been received.' } as const;
    client.setQueryFailure('getRecordOfFile', refusal);
    const { openFile, outputChannel } = makeEditor(client);

    const tab = await openFile(FILE);

    expect(pageGlobal(tab, 'mEditLoadError')).toEqual(refusal);
    expect(outputChannel.warn).not.toHaveBeenCalled();
  });

  it('empties the panel of an earlier failure when mEdit then refuses while a load order is on its way', async () => {
    const client = fileClient();
    client.setQueryFailureOnce('getRecordOfFile', { failed: 'unreachable' });
    client.setQueryFailure('getRecordOfFile', { failed: 'no-load-order', refusal: 'No load order has been received.' });
    const { openFile } = makeEditor(client);
    const tab = await openFile(FILE);
    expect(pageGlobal(tab, 'mEditLoadError')).toEqual({ failed: 'unreachable' });

    client.emit(reconcilingTick);

    await vi.waitFor(() => expect(pageGlobal(tab, 'mEditLoadError')).toBeUndefined());
  });

  it('asks again on mEdit\'s next load-order status, and shows the record once mEdit answers', async () => {
    const client = fileClient();
    client.setQueryFailureOnce('getRecordOfFile', { failed: 'unreachable' });
    client.setQueryAnswer('getRecordOfFile', holding(GUN));
    const { openFile } = makeEditor(client);
    const tab = await openFile(FILE);
    expect(pageGlobal(tab, 'mEditLoadError')).toEqual({ failed: 'unreachable' });

    client.emit(reconcilingTick);

    await vi.waitFor(() => expect(pageGlobal(tab, 'mEditFormKey')).toBe(GUN));
    expect(pageGlobal(tab, 'mEditLoadError')).toBeUndefined();
  });

  describe('and its document', () => {
    const fileDocument = (text: string, isDirty: boolean) => ({ text, isDirty, getText() { return this.text; } });
    const typed = { range: {}, text: 'x' };
    function holdingClient(): InMemoryMEditClient {
      const client = fileClient();
      client.setQueryAnswer('getRecordOfFile', holding(GUN));
      return client;
    }
    async function readOf(document: object, plugins = inactiveA): Promise<unknown[][]> {
      const client = holdingClient();
      client.setQueryAnswer('getPlugins', plugins);
      const { openFile } = makeEditor(client);
      const tab = await openFile(FILE, document);
      Object.assign(document, { text: '{ "EditorID": "Typed" }' });
      tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: GUN, columns: [] });
      await readAnswered(tab);
      return comparisonsAsked(client);
    }

    it('reads the file\'s column from the unsaved text as it is when the read is asked, its plugin active or not', async () => {
      const typedCopy = { plugin: { name: 'A.esp', origin: 'ModA' }, documentText: '{ "EditorID": "Typed" }', alone: false };
      expect(await readOf(fileDocument('{ "EditorID": "Gun" }', true), activeA)).toEqual([[GUN, typedCopy]]);
      expect(await readOf(fileDocument('{ "EditorID": "Gun" }', true), inactiveA)).toEqual([[GUN, typedCopy]]);
    });

    it('reads the file\'s column from mEdit once the document is saved and its plugin is active, as the read model\'s value wins', async () => {
      disk.set(FILE, '{ "EditorID": "OnDisk" }');
      expect(await readOf(fileDocument('{ "EditorID": "Gun" }', false), activeA)).toEqual([[GUN, undefined]]);
    });

    it('reads the file\'s column from the unsaved text beside the other records the tab shows', async () => {
      const client = holdingClient();
      client.setQueryAnswer('getRecordsComparison', { compare: comparisonOf('000800:A.esp', []), missing: [] });
      const { openFile } = makeEditor(client);
      const tab = await openFile(FILE, fileDocument('{ "EditorID": "Typed" }', true));
      const column = { formKey: '000900:B.esp', plugin: { name: 'B.esp', origin: 'ModB' } };

      tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: GUN, columns: [column] });
      await readAnswered(tab);

      expect(client.calls.filter(({ method }) => method === 'getRecordsComparison').map(({ args }) => args))
        .toEqual([[[{ formKey: GUN, plugin: { name: 'A.esp', origin: 'ModA' }, documentText: '{ "EditorID": "Typed" }' }, column]]]);
    });

    it.each([
      ['', '{ "EditorID": "OnDisk" }'],
      ['\uFEFF', '{ "EditorID": "OnDisk" }'],
    ])('reads the file\'s column from the file on disk once the document is saved and its plugin is not active, as mEdit compares no copy of it, without a byte order mark %j as its document\'s text has none', async (mark, text) => {
      disk.set(FILE, mark + text);
      expect(await readOf(fileDocument('{ "EditorID": "Gun" }', false)))
        .toEqual([[GUN, { plugin: { name: 'A.esp', origin: 'ModA' }, documentText: text, alone: false }]]);
    });

    it('reads the file\'s column from mEdit once the saved document is gone from disk', async () => {
      expect(await readOf(fileDocument('{ "EditorID": "Gun" }', false))).toEqual([[GUN, undefined]]);
    });

    it('fails the read, saying why, when the saved file on disk is not text', async () => {
      disk.set(FILE, new Uint8Array([0xff, 0xfe, 0xfd]));
      const client = holdingClient();
      client.setQueryAnswer('getPlugins', inactiveA);
      const { openFile } = makeEditor(client);
      const tab = await openFile(FILE, fileDocument('{}', false));

      tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: GUN, columns: [] });
      await readAnswered(tab);

      expect(tab.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'recordLoadAnswered', ok: false }));
      expect(comparisonsAsked(client)).toEqual([]);
    });

    it('reads the file\'s column from the file on disk when mEdit cannot say whether its plugin is active, so it shows either way', async () => {
      disk.set(FILE, '{ "EditorID": "OnDisk" }');
      const client = holdingClient();
      client.setQueryFailure('getPlugins', { failed: 'unreachable' });
      const { openFile } = makeEditor(client);
      const tab = await openFile(FILE, fileDocument('{}', false));

      tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: GUN, columns: [] });
      await readAnswered(tab);

      expect(comparisonsAsked(client)).toEqual([[GUN, { plugin: { name: 'A.esp', origin: 'ModA' }, documentText: '{ "EditorID": "OnDisk" }', alone: false }]]);
    });

    it('reads again when its text changes, and not when another document\'s does or a save leaves its text as it was', async () => {
      const { openFile } = makeEditor(holdingClient());
      const document = fileDocument('{}', true);
      const tab = await openFile(FILE, document);

      changeDocument({ document: { ...fileDocument('{}', true), uri: { scheme: 'file', fsPath: '/other.json' } }, contentChanges: [typed] });
      changeDocument({ document, contentChanges: [] });
      changeDocument({ document, contentChanges: [typed] });

      expect(tab.webview.postMessage.mock.calls).toEqual([[{ type: 'loadRecord', formKey: GUN }]]);
    });
  });
});

describe('a file whose plugin is disabled, or in a disabled mod', () => {
  const GUN = '000801:A.esp';
  const FILE = '/source/ModA/plugin-source/A.esp/Weapons/Gun.json';
  const typed = { plugin: COPY_PLUGIN, documentText: '{ "EditorID": "Typed" }' };
  const typedFile = { isDirty: true, getText: () => typed.documentText };
  const disabledA: ModFacts = { ...NO_MODS, standingOf: (plugin) => ({ kind: samePluginAddress(plugin, COPY_PLUGIN) ? 'disabled' : 'enabled' }) };
  const isAnswer = (message: unknown) => typeof message === 'object' && message !== null && Reflect.get(message, 'type') === 'recordLoadAnswered';
  type Opening = (editor: ReturnType<typeof makeEditor>) => Promise<FakePanel>;
  const openTyped: Opening = ({ openFile }) => openFile(FILE, typedFile);

  async function loaded(modFacts: ModFacts, { plugins = inactiveA, columns = [] as unknown[], open = openTyped } = {}) {
    const client = new InMemoryMEditClient();
    const copy = comparisonOf(GUN, [{ plugin: 'A.esp', origin: 'ModA', isWinner: false, editorId: 'Gun' }]);
    client.setQueryAnswer('getReferences', []);
    client.setQueryAnswer('getRecordOfFile', { formKey: GUN, plugin: { name: 'A.esp', origin: 'ModA' } });
    client.setQueryAnswer('getComparison', copy);
    client.setQueryAnswer('getRecordsComparison', { compare: copy, missing: [] });
    client.setQueryAnswer('getPlugins', plugins);
    const tab = await open(makeEditor(client, [], modFacts));
    tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: GUN, columns });
    await readAnswered(tab);
    const answers: unknown[] = tab.webview.postMessage.mock.calls.map((call: unknown[]) => call[0]).filter(isAnswer);
    return { asked: comparisonsAsked(client), told: answers.map((answer): unknown => Reflect.get(Object(answer), 'fileCopyAlone')) };
  }

  const renderedGun = { isDirty: false, getText: () => '{ "EditorID": "Rendered" }' };
  const savedGun = { isDirty: false, getText: () => '{}' };
  it.each([
    ['is read alone from its text, and its tab told so', disabledA, {}, { asked: [[GUN, { ...typed, alone: true }]], told: [true] }],
    ['is read alone from its rendered document, as a file is', disabledA, { open: ({ openDocument }) => openDocument(renderedUri(GUN, 'Gun.json'), renderedGun) },
      { asked: [[GUN, { plugin: COPY_PLUGIN, documentText: '{ "EditorID": "Rendered" }', alone: true }]], told: [true] }],
    ['is read in the comparison, its tab told so, once its saved file is gone from disk and no text is left to read alone', disabledA,
      { open: ({ openFile }) => openFile(FILE, savedGun) }, { asked: [[GUN, undefined]], told: [false] }],
    ['is read in the comparison while mEdit still has its plugin active', disabledA, { plugins: activeA }, { asked: [[GUN, { ...typed, alone: false }]], told: [false] }],
    ['is not read alone when its plugin is overridden', NO_MODS, {}, { asked: [[GUN, { ...typed, alone: false }]], told: [false] }],
    ['is not read alone beside the other records its tab shows', disabledA, { columns: [{ formKey: '000900:B.esp', plugin: { name: 'B.esp', origin: 'ModB' } }] },
      { asked: [], told: [false] }],
  ] satisfies [string, ModFacts, Parameters<typeof loaded>[1], unknown][])('%s', async (_, modFacts, options, read) => {
    expect(await loaded(modFacts, options)).toEqual(read);
  });

  it('is read again when the instance changes whether its plugin is disabled, and not when the instance changes otherwise', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', []);
    client.setQueryAnswer('getRecordOfFile', { formKey: GUN, plugin: { name: 'A.esp', origin: 'ModA' } });
    client.setQueryAnswer('getComparison', comparisonOf(GUN, [{ plugin: 'A.esp', origin: 'ModA', isWinner: false, editorId: 'Gun' }]));
    client.setQueryAnswer('getPlugins', inactiveA);
    let disabled = true;
    const changed: (() => void)[] = [];
    const modFacts: ModFacts = {
      ...NO_MODS, standingOf: () => ({ kind: disabled ? 'disabled' : 'enabled' }),
      onChange: (listener) => { changed.push(listener); return { dispose: () => undefined }; },
    };
    const tab = await makeEditor(client, [], modFacts).openFile(FILE, typedFile);
    const reads = () => tab.webview.postMessage.mock.calls.filter(([message]: unknown[]) => Reflect.get(Object(message), 'type') === 'loadRecord');

    changed.forEach((listener) => { listener(); });
    expect(reads()).toEqual([]);
    disabled = false;
    changed.forEach((listener) => { listener(); });

    expect(reads()).toEqual([[{ type: 'loadRecord', formKey: GUN }]]);
  });
});

describe('a file whose plugin is overridden', () => {
  const GUN = '000801:A.esp';
  const FILE = '/source/ModA/plugin-source/A.esp/Weapons/Gun.json';
  const typedFile = { isDirty: true, getText: () => '{ "EditorID": "Typed" }' };
  const overriddenBy = (by: string | undefined): ModFacts => ({ ...NO_MODS, standingOf: () => (by === undefined ? { kind: 'enabled' } : { kind: 'overridden', by }) });

  function clientFor(plugins: typeof inactiveA) {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', []);
    client.setQueryAnswer('getRecordOfFile', { formKey: GUN, plugin: { name: 'A.esp', origin: 'ModA' } });
    client.setQueryAnswer('getComparison', comparisonOf(GUN, [{ plugin: 'A.esp', origin: 'ModA', isWinner: false, editorId: 'Gun' }]));
    client.setQueryAnswer('getPlugins', plugins);
    return client;
  }

  async function told(modFacts: ModFacts, plugins = inactiveA) {
    const tab = await makeEditor(clientFor(plugins), [], modFacts).openFile(FILE, typedFile);
    tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: GUN, columns: [] });
    await readAnswered(tab);
    return tab.webview.postMessage.mock.calls.map((call: unknown[]) => call[0])
      .filter((m: unknown) => Reflect.get(Object(m), 'type') === 'recordLoadAnswered')
      .map((m: unknown): unknown => Reflect.get(Object(m), 'fileOverriddenBy'));
  }

  it.each([
    ['the mod that overrides it', overriddenBy('ModB'), inactiveA, ['ModB']],
    ['no mod when nothing overrides it', overriddenBy(undefined), inactiveA, [null]],
    ['no mod when its plugin is disabled', { ...NO_MODS, standingOf: () => ({ kind: 'disabled' }) } satisfies ModFacts, inactiveA, [null]],
    ['no mod while mEdit has its plugin active', overriddenBy('ModB'), activeA, [null]],
  ])('has its tab told %s', async (_, modFacts, plugins, expected) => {
    expect(await told(modFacts, plugins)).toEqual(expected);
  });

  it('is read again when the instance changes the mod that overrides it', async () => {
    let origin = 'ModB';
    const changed: (() => void)[] = [];
    const modFacts: ModFacts = {
      ...NO_MODS, standingOf: () => ({ kind: 'overridden', by: origin }),
      onChange: (listener) => { changed.push(listener); return { dispose: () => undefined }; },
    };
    const tab = await makeEditor(clientFor(inactiveA), [], modFacts).openFile(FILE, typedFile);
    const reads = () => tab.webview.postMessage.mock.calls.filter(([message]: unknown[]) => Reflect.get(Object(message), 'type') === 'loadRecord');

    changed.forEach((listener) => { listener(); });
    expect(reads()).toEqual([]);
    origin = 'ModC';
    changed.forEach((listener) => { listener(); });

    expect(reads()).toEqual([[{ type: 'loadRecord', formKey: GUN }]]);
  });
});

describe('a record tab closed while its read is in flight', () => {
  it('is told nothing and keeps its title when the read lands', async () => {
    const PLACED = '000803:A.esp';
    const client = new InMemoryMEditClient();
    let land: (answer: ReturnType<typeof comparisonOf>) => void = () => undefined;
    client.setQueryAnswerOnce('getComparison', new Promise((resolve) => { land = resolve; }));
    client.setQueryAnswer('getPlugins', []);
    const { openDocument } = makeEditor(client);
    const tab = await openDocument({
      scheme: 'modbench-child-record', path: '/source/ModA/plugin-source/A.esp/Cells/Cell.json', query: 'formKey=000803%3AA.esp&name=A.esp&origin=ModA',
    });
    tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: PLACED, columns: [] });

    tab.close();
    land(comparisonOf(PLACED, [{ plugin: 'A.esp', origin: 'ModA', isWinner: true, editorId: 'SharedRef' }]));
    await aMacrotask();

    expect(tab.webview.postMessage).not.toHaveBeenCalled();
    expect(tab.title).toBe(PLACED);
  });
});

describe('a record tab closed', () => {
  const GUN = '000801:A.esp';
  const FILE = '/source/ModA/plugin-source/A.esp/Weapons/Gun.json';
  const holding = { formKey: GUN, plugin: { name: 'A.esp', origin: 'ModA' } };

  it('before mEdit says which record its file holds shows nothing when the answer lands, nor is the record tab in focus', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', []);
    let land: (answer: typeof holding) => void = () => undefined;
    client.setQueryAnswerOnce('getRecordOfFile', new Promise<typeof holding>((resolve) => { land = resolve; }));
    makeEditor(client);
    const provider = editorProviders.get('modbench.record');
    if (!isRecordEditorProvider(provider)) throw new Error('no record editor registered');
    const tab = fakePanel();
    const resolving = provider.resolveCustomTextEditor({ uri: { scheme: 'file', fsPath: FILE } }, tab);

    tab.close();
    land(holding);
    await resolving;
    client.emit(conflictsComputedTick);

    expect(pageGlobal(tab, 'mEditFormKey')).toBeUndefined();
    expect(tab.webview.postMessage).not.toHaveBeenCalled();
    expect(await askedFromThePalette()).toEqual(PICKED);
  });

  it('lets go of what it listened to: its document\'s changes and the instance\'s mods', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getRecordOfFile', holding);
    const modsHeard = new Set<object>();
    const modFacts: ModFacts = { ...NO_MODS, onChange: () => {
      const heard = {};
      modsHeard.add(heard);
      return { dispose: () => { modsHeard.delete(heard); } };
    } };
    const { openFile } = makeEditor(client, [], modFacts);
    const documentsHeard = documentChanges.size;
    const tab = await openFile(FILE);
    expect([modsHeard.size, documentChanges.size]).toEqual([1, documentsHeard + 1]);

    tab.close();

    expect([modsHeard.size, documentChanges.size]).toEqual([0, documentsHeard]);
  });
});

describe('what a record tab\'s webview posts', () => {
  const GUN = '000801:A.esp';
  const compare = comparisonOf(GUN, [{ plugin: 'A.esp', isWinner: true, editorId: 'Gun' }]);
  const loadRequest = { type: WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD, requestId: 'r1', formKey: GUN, columns: [] };
  const answered = (tab: FakePanel) => tab.webview.postMessage.mock.calls.map((call: unknown[]) => call[0]);
  const loadAnswered = (tab: FakePanel) => answered(tab).filter((message) => typeof message === 'object' && message !== null && Reflect.get(message, 'type') === 'recordLoadAnswered');

  function client(): InMemoryMEditClient {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', []);
    client.setQueryAnswer('getComparison', compare);
    client.setQueryAnswer('getPlugins', activeA);
    return client;
  }

  describe('a read mEdit refuses for want of a load order', () => {
    const refusal = { failed: 'no-load-order', refusal: 'No load order has been received.' } as const;
    const cell = {
      scheme: 'modbench-child-record', path: '/source/ModA/plugin-source/A.esp/Cells/Cell.json', query: 'formKey=000801%3AA.esp&name=A.esp&origin=ModA',
    };
    const lastLoadAnswer = (tab: FakePanel) => loadAnswered(tab).at(-1);
    const loadRecordPosts = (tab: FakePanel) => answered(tab).filter((message) => typeof message === 'object' && message !== null && Reflect.get(message, 'type') === 'loadRecord');

    async function refusedTab() {
      const mEdit = client();
      mEdit.setQueryFailure('getComparison', refusal);
      const { openDocument, outputChannel } = makeEditor(mEdit);
      const tab = await openDocument(cell);
      tab.receive(loadRequest);
      return { tab, outputChannel, mEdit };
    }

    it('answers nothing and writes no line in the Output, while a load order is on its way and the tab has read nothing', async () => {
      const { tab, outputChannel } = await refusedTab();
      await aMacrotask();

      expect(loadAnswered(tab)).toEqual([]);
      expect(outputChannel.warn).not.toHaveBeenCalled();
    });

    it('is failed once no load order is on its way', async () => {
      loadOrder.coming = false;

      const { tab, outputChannel } = await refusedTab();
      await readAnswered(tab);

      expect(lastLoadAnswer(tab)).toEqual({ type: 'recordLoadAnswered', requestId: 'r1', ok: false, failure: refusal });
      expect(outputChannel.warn).not.toHaveBeenCalled();
    });

    it('reads again when Modbench declines to hand a load order, and is then failed', async () => {
      const { tab, outputChannel } = await refusedTab();
      const postsBefore = loadRecordPosts(tab).length;

      loadOrder.coming = false;
      loadOrder.changed();

      await vi.waitFor(() => expect(loadRecordPosts(tab)).toHaveLength(postsBefore + 1));
      tab.receive({ ...loadRequest, requestId: 'r2' });
      await readAnswered(tab, 'r2');
      expect(lastLoadAnswer(tab)).toEqual({ type: 'recordLoadAnswered', requestId: 'r2', ok: false, failure: refusal });
      expect(outputChannel.warn).not.toHaveBeenCalled();
    });

    it('reads again on a status once no load order is coming', async () => {
      const { tab, mEdit } = await refusedTab();
      const postsBefore = loadRecordPosts(tab).length;

      loadOrder.coming = false;
      mEdit.emit(reconcilingTick);

      await vi.waitFor(() => expect(loadRecordPosts(tab)).toHaveLength(postsBefore + 1));
    });

    it('reads again once the load order\'s reconcile settles, and lands the record', async () => {
      const mEdit = client();
      mEdit.setQueryFailureOnce('getComparison', refusal);
      const { openDocument } = makeEditor(mEdit);
      const tab = await openDocument(cell);
      tab.receive(loadRequest);
      await aMacrotask();
      const postsBefore = loadRecordPosts(tab).length;

      mEdit.emit(conflictsComputedTick);

      await vi.waitFor(() => expect(loadRecordPosts(tab)).toHaveLength(postsBefore + 1));
      tab.receive({ ...loadRequest, requestId: 'r2' });
      await readAnswered(tab, 'r2');
      expect(lastLoadAnswer(tab)).toMatchObject({ requestId: 'r2', ok: true });
    });

    it('is failed in the Output once a read of the tab has landed', async () => {
      const mEdit = client();
      const { openDocument, outputChannel } = makeEditor(mEdit);
      const tab = await openDocument(cell);
      tab.receive(loadRequest);
      await readAnswered(tab);
      mEdit.setQueryFailure('getComparison', refusal);

      tab.receive({ ...loadRequest, requestId: 'r2' });
      await readAnswered(tab, 'r2');

      expect(lastLoadAnswer(tab)).toEqual({ type: 'recordLoadAnswered', requestId: 'r2', ok: false, failure: refusal });
      expect(outputChannel.warn).not.toHaveBeenCalled();
    });
  });

  describe('an edit of a field', () => {
    const [FORM_KEY, MODDED] = ['000800:A.esp', '000900:A.esp'];
    const path = [{ kind: 'member', name: 'Keywords' }];
    function editing(): InMemoryMEditClient {
      const editing = client();
      editing.setQueryAnswer('getCopyDocument', { kind: 'OwnFile', location: '/source/ModA/plugin-source/A.esp/Npcs/Npc.json' });
      editing.setQueryAnswer('getRecordOfFile', { formKey: FORM_KEY, plugin: { name: 'A.esp', origin: 'ModA' } });
      editing.setQueryAnswer('getEditChanges', { applied: true, moves: [], deletions: [], documents: [] });
      return editing;
    }
    const edits = (client: InMemoryMEditClient) => client.calls.filter(({ method }) => method === 'getEditChanges').map(({ args }) => args.slice(0, 3));

    it('is sent to mEdit for the column\'s (origin, filename), with the envelope the grid posted', async () => {
      const mEdit = editing();
      const { open } = makeEditor(mEdit);
      const envelope = { op: 'set', path: [{ kind: 'member', name: 'Height' }], value: 0.75 };

      open(FORM_KEY).receive({ type: WEBVIEW_TO_EXTENSION.EDIT_FIELD, formKey: FORM_KEY, plugin: 'A.esp', origin: 'ModA', envelope });

      await vi.waitFor(() => expect(edits(mEdit)).toEqual([[FORM_KEY, { name: 'A.esp', origin: 'ModA' }, envelope]]));
    });

    it('is sent with the value a drop supplies, for an element added', async () => {
      const mEdit = editing();
      const { open } = makeEditor(mEdit);
      const context = { webviewSection: 'arrayParent', formKey: FORM_KEY, plugin: 'A.esp', origin: 'ModA', path, preventDefaultContextMenuItems: true };

      open(FORM_KEY).receive({ type: WEBVIEW_TO_EXTENSION.ADD_ELEMENT, context, value: { Keyword: GUN } });

      await vi.waitFor(() => expect(edits(mEdit)).toEqual([[FORM_KEY, { name: 'A.esp', origin: 'ModA' }, { op: 'add', path, value: { Keyword: GUN } }]]));
    });

    it('from a right-click, on a record the tab\'s last edit moved, is sent to the FormKey the record is at now', async () => {
      const mEdit = editing();
      mEdit.setQueryAnswer('getEditChanges', { applied: true, newFormKey: MODDED, moves: [], deletions: [], documents: [] });
      const { open } = makeEditor(mEdit);
      const tab = open(FORM_KEY);
      const context = { webviewSection: 'arrayParent', formKey: FORM_KEY, plugin: 'A.esp', origin: 'ModA', path, preventDefaultContextMenuItems: true };
      await commandHandlers.get('modbench.record.editField')?.(
        { formKey: FORM_KEY, plugin: 'A.esp', origin: 'ModA' }, { op: 'set', path, value: 'x' });
      mEdit.setQueryAnswer('getEditChanges', { applied: true, moves: [], deletions: [], documents: [] });

      await commandHandlers.get('modbench.record.addElement')?.(context);

      expect(edits(mEdit).map(([formKey]) => formKey)).toEqual([FORM_KEY, MODDED]);
      expect(tab.webview.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('that names nothing the host knows', () => {
    it.each([
      ['a type this build does not know', { type: 'somethingElse' }],
      ['a string', 'not an object'],
      ['null', null],
    ])('is dropped, as %s, saying in the Output what the page sent', async (_, message) => {
      const mEdit = client();
      const { open, outputChannel } = makeEditor(mEdit);
      const tab = open(GUN);
      const [executed, asked] = [executeCommand.mock.calls.length, mEdit.calls.length];

      tab.receive(message);
      await vi.waitFor(() => expect(outputChannel.warn).toHaveBeenCalled());

      expect([executeCommand.mock.calls.length, mEdit.calls.length]).toEqual([executed, asked]);
      expect(tab.webview.postMessage).not.toHaveBeenCalled();
      const logged: unknown = outputChannel.warn.mock.calls.at(-1)?.[0];
      expect(logged).toMatch(/^Dropped a message from a record tab's page: /);
      expect(logged).toContain(JSON.stringify(message));
    });

    it('is dropped, saying so in the Output, as a value JSON cannot write', async () => {
      const { open, outputChannel } = makeEditor(client());
      const tab = open(GUN);

      tab.receive({ type: 'sentByAnotherExtension', count: BigInt(1) });

      await vi.waitFor(() => expect(outputChannel.warn).toHaveBeenCalledWith(expect.stringMatching(/^Dropped a message from a record tab's page: /)));
    });
  });

  it.each([
    ['a FormKey the picker', { type: WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER, requestId: 'r1', seed: '', validTypes: [] },
      { type: 'formKeyPicked', requestId: 'r1', formKey: null }],
    ['an enum value the pick', { type: WEBVIEW_TO_EXTENSION.OPEN_ENUM_PICKER, requestId: 'r1', choices: [{ value: 'A', label: 'A' }], current: 'A' },
      { type: 'enumPicked', requestId: 'r1', value: null }],
  ])('answers a request for %s was dismissed on with null, correlated by requestId', async (_, request, answer) => {
    const { open } = makeEditor(client());
    const tab = open(GUN);

    tab.receive(request);

    await vi.waitFor(() => expect(tab.webview.postMessage).toHaveBeenCalledWith(answer));
  });

  describe('a request for the record', () => {
    it('is answered with the comparison, the plugin list, whether conflicts are computed, the plugins mEdit cannot read and the plugin the tab\'s document holds', async () => {
      const mEdit = client();
      const { open } = makeEditor(mEdit);
      const tab = open(GUN);
      const failure = { name: 'Bad.esp', origin: 'Mod', reason: 'truncated' };
      mEdit.emit(loadOrderStatusEventFixture({ failures: [failure] }));

      tab.receive(loadRequest);
      await readAnswered(tab);

      expect(loadAnswered(tab)).toEqual([{
        type: 'recordLoadAnswered', requestId: 'r1', ok: true, compare, plugins: activeA, conflictsComputed: true,
        loadFailures: [failure], documentPlugin: COPY_PLUGIN, modsByOrigin: {}, fileCopyAlone: false, fileOverriddenBy: null,
      }]);
      expect(comparisonsAsked(mEdit)).toEqual([[GUN, undefined]]);
    });

    describe('for a record no active plugin holds', () => {
      const gone: { formKey: string; plugin: { name: string; origin: string }; reason: 'RecordGone' | 'NotInPlugin'; message: string } = { formKey: GUN, plugin: { name: 'A.esp', origin: 'ModA' }, reason: 'RecordGone', message: `${GUN} is held by no plugin.` };
      const answeredFor = async (answer: { compare: typeof compare | null; missing: (typeof gone)[] }) => {
        const mEdit = client();
        mEdit.setQueryAnswer('getComparison', null);
        mEdit.setQueryAnswer('getRecordsComparison', answer);
        const { open, outputChannel } = makeEditor(mEdit);
        const tab = open(GUN);

        tab.receive(loadRequest);
        await readAnswered(tab);
        return { tab, outputChannel };
      };

      it('is answered gone, naming it, when no registered plugin holds it', async () => {
        const { tab, outputChannel } = await answeredFor({ compare: null, missing: [gone] });

        expect(loadAnswered(tab)).toEqual([expect.objectContaining({ ok: true, compare: null, gone: [GUN], copiesLacking: [], conflictsComputed: false, loadFailures: [] })]);
        expect(outputChannel.warn).toHaveBeenCalledWith(expect.stringContaining(GUN));
      });

      it('is answered with the copy a disabled plugin holds, and not as gone', async () => {
        const { tab } = await answeredFor({ compare, missing: [] });

        expect(loadAnswered(tab)).toEqual([expect.objectContaining({ ok: true, compare })]);
      });

      it('is refused, not gone, when only a plugin other than the tab\'s holds it', async () => {
        const { tab } = await answeredFor({ compare: null, missing: [{ ...gone, reason: 'NotInPlugin', message: `${GUN} is not in A.esp (ModA).` }] });

        expect(tab.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ ok: false, failure: { failed: 'refused', refusal: `${GUN} is not in A.esp (ModA).` } }));
      });
    });

    it('is answered with a null plugin list, rather than failed, when only the list fails', async () => {
      const mEdit = client();
      mEdit.setQueryFailure('getPlugins', { failed: 'unreachable' });
      const { openDocument } = makeEditor(mEdit);
      const tab = await openDocument(renderedUri(GUN, 'Gun.json'), { getText: () => '{}' });

      tab.receive(loadRequest);
      await readAnswered(tab);

      expect(loadAnswered(tab)).toEqual([expect.objectContaining({ ok: true, compare, plugins: null })]);
    });

    it.each([
      ['an active plugin in a source mod', activeA, 'ModA', { ModA: 'sourceMod' }],
      ['a disabled plugin in a source mod', inactiveA, 'ModA', { ModA: 'sourceMod' }],
      ['an active plugin in a non-source mod', activeA, 'ModB', { ModB: 'nonSourceMod' }],
      ['a disabled plugin in a non-source mod', inactiveA, 'ModB', { ModB: 'nonSourceMod' }],
      ['a plugin in a mod whose folder spells the origin in another case', activeA, 'modb', { modb: 'nonSourceMod' }],
      ['a plugin in the game folder', activeA, DATA_DIRECTORY_ORIGIN, {}],
      ['a plugin in Overwrite', activeA, 'Overwrite', {}],
    ])('is answered with the repository state of the mod each origin names, for %s', async (_what, plugins, origin, modsByOrigin) => {
      const mEdit = client();
      mEdit.setQueryAnswer('getPlugins', plugins);
      mEdit.setQueryAnswer('getComparison', comparisonOf(GUN, [{ plugin: 'A.esp', origin, isWinner: true, editorId: 'Gun' }]));
      const modFacts = { ...NO_MODS, listedSourceMods: () => new Set(['ModA']), modOfOrigin: modOfOriginIn('ModA', 'ModB') };
      const { openDocument } = makeEditor(mEdit, undefined, modFacts);
      const tab = await openDocument(renderedUri(GUN, 'Gun.json'), { getText: () => '{}' });

      tab.receive(loadRequest);
      await readAnswered(tab);

      expect(loadAnswered(tab)).toEqual([expect.objectContaining({ ok: true, modsByOrigin })]);
    });

    it('tells the tab the repository state of the origins it showed when the instance changes', async () => {
      const mEdit = client();
      mEdit.setQueryAnswer('getPlugins', activeA);
      mEdit.setQueryAnswer('getComparison', comparisonOf(GUN, [{ plugin: 'A.esp', origin: 'ModB', isWinner: true, editorId: 'Gun' }]));
      let compiledPlugin = new Set<string>();
      const changed: (() => void)[] = [];
      const modFacts = {
        ...NO_MODS, listedSourceMods: () => compiledPlugin, modOfOrigin: modOfOriginIn('ModB'),
        onChange: (listener: () => void) => { changed.push(listener); return { dispose: () => undefined }; },
      };
      const { openDocument } = makeEditor(mEdit, undefined, modFacts);
      const tab = await openDocument(renderedUri(GUN, 'Gun.json'), { getText: () => '{}' });
      tab.receive(loadRequest);
      await readAnswered(tab);
      const told = () => answered(tab).filter((message) => typeof message === 'object' && message !== null && Reflect.get(message, 'type') === 'modsChanged');

      compiledPlugin = new Set(['ModB']);
      changed.forEach((listener) => { listener(); });

      expect(told()).toEqual([{ type: 'modsChanged', modsByOrigin: { ModB: 'sourceMod' } }]);
    });

    it('is failed, naming the record in the Output and leaving the tab\'s title, when the comparison fails', async () => {
      const mEdit = client();
      mEdit.setQueryFailure('getComparison', { failed: 'unreachable' });
      const { openDocument, outputChannel } = makeEditor(mEdit);
      const tab = await openDocument({
        scheme: 'modbench-child-record', path: '/source/ModA/plugin-source/A.esp/Cells/Cell.json', query: 'formKey=000801%3AA.esp&name=A.esp&origin=ModA',
      });

      tab.receive(loadRequest);
      await readAnswered(tab);

      expect(loadAnswered(tab)).toEqual([{ type: 'recordLoadAnswered', requestId: 'r1', ok: false, failure: { failed: 'unreachable' } }]);
      expect(outputChannel.warn).not.toHaveBeenCalled();
      expect(tab.title).toBe(GUN);
    });
  });
});

describe('a click on a column\'s header', () => {
  it('opens the records it names through the open command, as a preview', async () => {
    const gun = { formKey: '000801:A.esp', plugin: COPY_PLUGIN };
    const { openDocument } = makeEditor();
    const tab = await openDocument(renderedUri(gun.formKey, 'Gun.json'));
    const knife = { formKey: '000803:B.esp', plugin: { name: 'B.esp', origin: 'ModB' } };

    tab.receive({ type: 'openColumns', records: [knife] });

    expect(executed().filter(([id]) => id === 'modbench.record.open'))
      .toEqual([['modbench.record.open', [{ argument: { kind: 'record', ...knife } }]]]);
  });
});

describe('a non-compiled plugin copy\'s tab', () => {
  const GUN = '000801:A.esp';
  const RENDERED = renderedUri(GUN, 'Gun.json');

  it('shows the copy\'s record, asked about by Referenced By, with no file for mEdit to name it by', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', []);
    client.setQueryAnswer('getComparison', comparisonOf(GUN, [{ plugin: 'A.esp', isWinner: true, editorId: 'Gun' }]));
    const { openDocument } = makeEditor(client);

    const tab = await openDocument(RENDERED);

    expect(pageGlobal(tab, 'mEditFormKey')).toBe(GUN);
    expect(await askedFromThePalette()).toEqual(listing('Gun'));
    expect(client.calls.map(({ method }) => method)).not.toContain('getRecordOfFile');
  });

  async function readOf(plugins: typeof activeA): Promise<unknown[][]> {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getComparison', null);
    client.setQueryAnswer('getPlugins', plugins);
    const { openDocument } = makeEditor(client);
    const tab = await openDocument(RENDERED, { isDirty: false, getText: () => '{ "EditorID": "Rendered" }' });

    tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: GUN, columns: [] });
    await readAnswered(tab);
    return comparisonsAsked(client);
  }

  it.each([
    ['every column from mEdit while the copy\'s plugin is active, its document being mEdit\'s own copy', activeA, undefined],
    ['the copy\'s column from its document while its plugin is not active, as mEdit compares no copy of it', inactiveA,
      { plugin: { name: 'A.esp', origin: 'ModA' }, documentText: '{ "EditorID": "Rendered" }', alone: false }],
  ])('reads %s', async (_, plugins, read) => {
    expect(await readOf(plugins)).toEqual([[GUN, read]]);
  });
});

describe('a child record\'s tab', () => {
  const PLACED = '000803:A.esp';
  const CHILD = { scheme: 'modbench-child-record', path: '/source/ModA/plugin-source/A.esp/Cells/Cell.json', query: 'formKey=000803%3AA.esp&name=A.esp&origin=ModA' };

  it('shows the child\'s record, not its container\'s, titled with the opened copy\'s name once its read is answered', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', []);
    client.setQueryAnswer('getComparison', comparisonOf(PLACED, [
      { plugin: 'A.esp', origin: 'ModA', isWinner: false, editorId: 'SharedRef' },
      { plugin: 'B.esp', origin: 'ModB', isWinner: true, editorId: 'RenamedRef' },
    ]));
    client.setQueryAnswer('getPlugins', []);
    const { openDocument } = makeEditor(client);

    const tab = await openDocument(CHILD);
    expect(pageGlobal(tab, 'mEditFormKey')).toBe(PLACED);
    expect(tab.title).toBe(PLACED);
    tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: PLACED, columns: [] });

    await vi.waitFor(() => expect(tab.title).toBe('SharedRef'));
    expect(client.calls.map(({ method }) => method)).not.toContain('getRecordOfFile');
  });

  async function readOf(document: object, plugins = inactiveA): Promise<unknown[][]> {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getComparison', null);
    client.setQueryAnswer('getPlugins', plugins);
    const { openDocument } = makeEditor(client);
    const tab = await openDocument(CHILD, document);

    tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: PLACED, columns: [] });
    await readAnswered(tab);
    return comparisonsAsked(client);
  }

  const copyOfText = (documentText: string) => ({ plugin: { name: 'A.esp', origin: 'ModA' }, documentText, alone: false });
  it.each([
    ['its container\'s unsaved text, out of which mEdit reads the child', true, activeA, copyOfText('{ "EditorID": "Cell" }')],
    ['mEdit once its container is saved and its plugin is active', false, activeA, undefined],
    ['its container\'s file on disk once it is saved and its plugin is not active', false, inactiveA, copyOfText('{ "EditorID": "OnDisk" }')],
  ])('reads the child\'s column from %s', async (_, isDirty, plugins, read) => {
    disk.set(CHILD.path, '{ "EditorID": "OnDisk" }');
    expect(await readOf({ isDirty, getText: () => '{ "EditorID": "Cell" }' }, plugins)).toEqual([[PLACED, read]]);
  });

  it('reads again when its container\'s text changes, and not when another document\'s does', async () => {
    const { openDocument } = makeEditor(new InMemoryMEditClient());
    const document = { isDirty: true, getText: () => '{}' };
    const tab = await openDocument(CHILD, document);
    const typed = { range: {}, text: 'x' };

    changeDocument({ document: { uri: { scheme: 'file', fsPath: '/other.json' }, isDirty: true, getText: () => '{}' }, contentChanges: [typed] });
    changeDocument({ document, contentChanges: [typed] });

    expect(tab.webview.postMessage.mock.calls).toEqual([[{ type: 'loadRecord', formKey: PLACED }]]);
  });
});

describe('several records opened at once', () => {
  const [GUN, AMMO, KNIFE] = ['000801:A.esp', '000802:A.esp', '000803:C.esp'];
  const winner = { name: 'B.esp', origin: 'ModB' };
  const knifeIn = { name: 'C.esp', origin: 'ModC' };
  const gunDocument = renderedUri(GUN, 'Gun.json');
  const columnsPosted = (tab: FakePanel | undefined) => tab?.webview.postMessage.mock.calls.filter(([message]) => isShowColumns(message));
  const firstRead = { type: 'requestRecordLoad', requestId: 'r0', formKey: GUN, columns: [] };
  const openSeveral = () => commandHandlers.get('modbench.record.open')?.(
    [{ argument: { kind: 'record', formKey: GUN, plugin: COPY_PLUGIN } }, { argument: { kind: 'record', formKey: AMMO } },
      { argument: { kind: 'record', formKey: KNIFE, plugin: knifeIn } }]);
  function severalClient(): InMemoryMEditClient {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', []);
    client.setQueryAnswer('getRecordOwner', winner);
    client.setQueryAnswer('getCopyDocument', { kind: 'Rendered', location: 'Gun.json' });
    client.setQueryAnswer('getPlugins', activeA);
    client.setQueryAnswer('getComparison', null);
    return client;
  }

  it('open one grid, a preview: the first record\'s document, with the others as its columns in the order given, each without a plugin its winning copy', async () => {
    const { vsCodeOpensTabs } = makeEditor(severalClient());
    const tabOn = vsCodeOpensTabs();

    await openSeveral();

    expect(executed().filter(([id]) => id === 'vscode.openWith'))
      .toEqual([['vscode.openWith', gunDocument, 'modbench.record', { viewColumn: -1, preview: true }]]);
    const tab = tabOn(gunDocument);
    expect(pageGlobal(tab ?? fakePanel(), 'mEditColumns'))
      .toEqual([{ formKey: AMMO, plugin: winner }, { formKey: KNIFE, plugin: knifeIn }]);
    expect(tab?.webview.postMessage).not.toHaveBeenCalled();
  });

  it('give the columns to the tab VS Code resolves after the open has answered', async () => {
    const { vsCodeOpensTabs } = makeEditor(severalClient());
    const tabOn = vsCodeOpensTabs({ resolvesAfterOpenAnswers: true });

    await openSeveral();

    await vi.waitFor(() => expect(pageGlobal(tabOn(gunDocument) ?? fakePanel(), 'mEditColumns'))
      .toEqual([{ formKey: AMMO, plugin: winner }, { formKey: KNIFE, plugin: knifeIn }]));
  });

  it('show the first record\'s tab already open, which takes the others as its columns, and leave its tab in another group alone', async () => {
    const { vsCodeOpensTabs, openDocument } = makeEditor(severalClient());
    const tabOn = vsCodeOpensTabs();
    await commandHandlers.get('modbench.record.open')?.({ argument: { kind: 'record', formKey: GUN, plugin: COPY_PLUGIN } });
    tabOn(gunDocument)?.receive(firstRead);
    const elsewhere = await openDocument(gunDocument);
    elsewhere.active = false;

    await openSeveral();

    expect(columnsPosted(tabOn(gunDocument))).toEqual([[{
      type: 'showColumns', columns: [{ formKey: AMMO, plugin: winner }, { formKey: KNIFE, plugin: knifeIn }],
    }]]);
    expect(elsewhere.webview.postMessage).not.toHaveBeenCalled();
  });

  it('hold the columns for a tab whose page has asked no read yet, which listens only once it has', async () => {
    const { vsCodeOpensTabs } = makeEditor(severalClient());
    const tabOn = vsCodeOpensTabs();
    await commandHandlers.get('modbench.record.open')?.({ argument: { kind: 'record', formKey: GUN, plugin: COPY_PLUGIN } });
    const tab = present(tabOn(gunDocument), 'the first record\'s tab');
    const page: string[] = [];
    tab.webview.postMessage.mockImplementation((message: unknown) => {
      if (isShowColumns(message)) page.push('columns shown');
      return Promise.resolve(true);
    });

    await openSeveral();
    page.push('read asked');
    tab.receive(firstRead);

    await vi.waitFor(() => expect(page).toEqual(['read asked', 'columns shown']));
  });

  it('show their columns on a file\'s tab already open, once mEdit says which record its file holds', async () => {
    const GUN_FILE = '/source/ModA/plugin-source/A.esp/Weapons/Gun.json';
    const client = severalClient();
    client.setQueryAnswer('getCopyDocument', { kind: 'OwnFile', location: GUN_FILE });
    client.setQueryFailureOnce('getRecordOfFile', { failed: 'unreachable' });
    client.setQueryAnswer('getRecordOfFile', { formKey: GUN, plugin: COPY_PLUGIN });
    const { openDocument } = makeEditor(client);
    const tab = await openDocument(vscode.Uri.file(GUN_FILE));

    await openSeveral();
    client.emit(reconcilingTick);
    await vi.waitFor(() => expect(pageGlobal(tab, 'mEditFormKey')).toBe(GUN));
    expect(columnsPosted(tab)).toEqual([]);
    tab.receive(firstRead);

    await vi.waitFor(() => expect(columnsPosted(tab)).toEqual([[{
      type: 'showColumns', columns: [{ formKey: AMMO, plugin: winner }, { formKey: KNIFE, plugin: knifeIn }],
    }]]));
  });

  it('leave the tab they opened to show every active plugin\'s copy again when its record is opened alone onto it', async () => {
    const { vsCodeOpensTabs } = makeEditor(severalClient());
    const tabOn = vsCodeOpensTabs();
    await openSeveral();
    tabOn(gunDocument)?.receive(firstRead);

    await commandHandlers.get('modbench.record.open')?.({ argument: { kind: 'record', formKey: GUN, plugin: COPY_PLUGIN } });

    expect(columnsPosted(tabOn(gunDocument))).toEqual([[{ type: 'showColumns', columns: [] }]]);
  });

  it('read the tab again when mEdit reports a record of another column changed, and not for a record it does not show', async () => {
    const client = severalClient();
    client.setQueryAnswer('getRecordsComparison', { compare: comparisonOf('000800:A.esp', []), missing: [] });
    const { openDocument } = makeEditor(client);
    const tab = await openDocument(gunDocument);
    tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: GUN, columns: [{ formKey: AMMO, plugin: winner }] });
    await readAnswered(tab);

    client.emit(notificationEventFixture({ kind: 'rows-changed', plugin: 'C.esp', origin: 'ModC', keys: [KNIFE], sequence: 1 }));
    client.emit(notificationEventFixture({ kind: 'rows-changed', plugin: 'B.esp', origin: 'ModB', keys: [AMMO], sequence: 2 }));

    expect(tab.webview.postMessage.mock.calls).toEqual([[expect.objectContaining({ type: 'recordLoadAnswered' })], [{ type: 'loadRecord', formKey: GUN }]]);
  });

  describe('refused for a copy no plugin gives', () => {
    const missing = (formKey: string, reason: 'RecordGone' | 'NotInPlugin') => ({
      formKey, plugin: { name: 'B.esp', origin: 'ModB' }, reason, message: `${formKey} is not in B.esp (ModB).`,
    });
    const loadWithAColumn = async (...refused: ReturnType<typeof missing>[]) => {
      const client = severalClient();
      client.setQueryAnswer('getRecordsComparison', { compare: null, missing: refused });
      const { openDocument, outputChannel } = makeEditor(client);
      const tab = await openDocument(gunDocument);
      tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: GUN, columns: [{ formKey: AMMO, plugin: winner }] });
      await readAnswered(tab);
      return { tab, client, channel: outputChannel };
    };

    it('answer with the reason mEdit gave, naming each copy, when a plugin lacks only its copy', async () => {
      const { tab, client } = await loadWithAColumn(missing(AMMO, 'NotInPlugin'));

      expect(tab.webview.postMessage).toHaveBeenCalledWith(
        { type: 'recordLoadAnswered', requestId: 'r1', ok: false, failure: { failed: 'refused', refusal: `${AMMO} is not in B.esp (ModB).` } });
      expect(comparisonsAsked(client)).toEqual([]);
    });

    it('answer that the column record is gone, naming it, when no plugin holds it', async () => {
      const { tab, client } = await loadWithAColumn(missing(AMMO, 'RecordGone'));

      expect(tab.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'recordLoadAnswered', ok: true, compare: null, gone: [AMMO], copiesLacking: [] }));
      expect(comparisonsAsked(client)).toEqual([]);
    });

    it('answer that the tab\'s own record is gone when no plugin holds it', async () => {
      const { tab } = await loadWithAColumn(missing(GUN, 'RecordGone'));

      expect(tab.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ ok: true, compare: null, gone: [GUN] }));
    });

    it('name every gone record once, in the grid\'s order', async () => {
      const { tab } = await loadWithAColumn(missing(GUN, 'RecordGone'), missing(AMMO, 'RecordGone'), missing(GUN, 'RecordGone'));

      expect(tab.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ ok: true, compare: null, gone: [GUN, AMMO] }));
    });

    it('keep mEdit\'s word on a copy only its plugin lacks beside the records that are gone', async () => {
      const { tab } = await loadWithAColumn(missing(AMMO, 'RecordGone'), missing(KNIFE, 'NotInPlugin'));

      expect(tab.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
        ok: true, compare: null, gone: [AMMO], copiesLacking: [`${KNIFE} is not in B.esp (ModB).`],
      }));
    });

    it('write the gone records to the Output', async () => {
      const { channel } = await loadWithAColumn(missing(AMMO, 'RecordGone'), missing(KNIFE, 'NotInPlugin'));

      expect(channel.warn).toHaveBeenCalledWith(expect.stringContaining(AMMO));
      expect(channel.warn).toHaveBeenCalledWith(expect.stringContaining(`${KNIFE} is not in B.esp (ModB).`));
    });
  });

  it('read the first record\'s copy and the columns the tab shows side by side, in that order', async () => {
    const client = severalClient();
    client.setQueryAnswer('getRecordsComparison', { compare: comparisonOf('000800:A.esp', []), missing: [] });
    const { openDocument } = makeEditor(client);
    const tab = await openDocument(gunDocument);

    tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: GUN, columns: [{ formKey: AMMO, plugin: winner }] });
    await readAnswered(tab);

    expect(client.calls.filter(({ method }) => method === 'getRecordsComparison').map(({ args }) => args))
      .toEqual([[[{ formKey: GUN, plugin: COPY_PLUGIN }, { formKey: AMMO, plugin: winner }]]]);
    expect(comparisonsAsked(client)).toEqual([]);
  });
});

describe('mEdit\'s reports to an open record tab', () => {
  const GUN = '000801:A.esp';
  const reported = (kind: 'rows-changed' | 'plugin-changed', keys: string[]) =>
    notificationEventFixture({ kind, plugin: 'A.esp', origin: 'ModA', keys, sequence: 1 });

  it('has a tab read its record again when a report names it, and not when a report names another record or a plugin\'s change', () => {
    const client = new InMemoryMEditClient();
    const { open } = makeEditor(client);
    const tab = open(GUN);

    client.emit(reported('rows-changed', ['000802:A.esp']));
    client.emit(reported('plugin-changed', [GUN]));
    expect(tab.webview.postMessage).not.toHaveBeenCalled();

    client.emit(reported('rows-changed', [GUN]));
    expect(tab.webview.postMessage.mock.calls).toEqual([[{ type: 'loadRecord', formKey: GUN }]]);
  });

  it('is not heard once the Editor is disposed', () => {
    const client = new InMemoryMEditClient();
    const { editor, open } = makeEditor(client);
    const tab = open(GUN);

    editor.dispose();
    client.emit(reported('rows-changed', [GUN]));

    expect(tab.webview.postMessage).not.toHaveBeenCalled();
  });
});

describe('a record tab', () => {
  it('keeps its page alive while it is hidden', () => {
    makeEditor();

    expect(editorProviderOptions.get('modbench.record')).toEqual({ webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true } });
  });
});

describe('the grid\'s F2', () => {
  it('opens the editor of the focused cell of the record tab in focus, and of no other tab', async () => {
    const { open } = makeEditor();
    const behind = open('000801:A.esp');
    const inFocus = open('000802:A.esp');

    await commandHandlers.get('modbench.recordGrid.editHere')?.();

    expect(inFocus.webview.postMessage).toHaveBeenCalledWith({ type: 'openCellEditor' });
    expect(behind.webview.postMessage).not.toHaveBeenCalled();
  });
});

describe('the Editor disposed', () => {
  it('lets go of what it registered once, however often it is disposed', () => {
    const { editor } = makeEditor();
    editorProviderDisposals.count = 0;

    editor.dispose();
    editor.dispose();

    expect(editorProviderDisposals.count).toBe(editorProviders.size);
  });
});

describe('Collapse No Conflict reaches every record panel', () => {
  const KEY = 'modbench.record.noConflictCollapsed';
  const lens = (tab: FakePanel) => (tab.webview.postMessage.mock.calls as unknown[][])
    .map(([message]) => message)
    .filter((message) => typeof message === 'object' && message !== null && 'type' in message && message.type === 'collapseNoConflict');
  const pageAsksItsFirstRead = (tab: FakePanel) => { tab.receive({ type: 'requestRecordLoad', requestId: 'r1', formKey: '000801:A.esp', columns: [] }); };
  const run = async (command: string) => { await commandHandlers.get(command)?.(); };

  function twoTabs() {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getComparison', null);
    const editor = makeEditor(client);
    const tabs = [editor.open('000801:A.esp'), editor.open('000802:A.esp')];
    tabs.forEach(pageAsksItsFirstRead);
    return { ...editor, tabs };
  }

  it('starts showing every row, and says so in the context key the title bar reads', () => {
    makeEditor();

    expect(contextKeys.get(KEY)).toBe(false);
  });

  it('collapses every open record tab, and shows them again', async () => {
    const { tabs } = twoTabs();

    await run('modbench.record.collapseNoConflict');
    expect(tabs.map(lens)).toEqual([[{ type: 'collapseNoConflict', on: true, again: true }], [{ type: 'collapseNoConflict', on: true, again: true }]]);
    expect(contextKeys.get(KEY)).toBe(true);

    await run('modbench.record.showNoConflict');
    expect(tabs.map(lens).map((heard) => heard.at(-1))).toEqual([{ type: 'collapseNoConflict', on: false, again: true }, { type: 'collapseNoConflict', on: false, again: true }]);
    expect(contextKeys.get(KEY)).toBe(false);
  });

  it('collapses a tab opened while it is on, once its page listens', async () => {
    const { open } = twoTabs();
    await run('modbench.record.collapseNoConflict');

    const later = open('000803:A.esp');
    expect(lens(later)).toEqual([]);
    pageAsksItsFirstRead(later);

    await vi.waitFor(() => expect(lens(later)).toEqual([{ type: 'collapseNoConflict', on: true, again: false }]));
  });

  it('opens a tab showing every row when it is off, and says nothing to its page', async () => {
    const { open } = twoTabs();

    const later = open('000803:A.esp');
    pageAsksItsFirstRead(later);
    await aMacrotask();

    expect(lens(later)).toEqual([]);
  });
});
