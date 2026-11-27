import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FakeUri } from '../../test/vscodeMock';

interface ChangeEvent { type: number; uri: FakeUri }
interface Provider {
  stat(uri: FakeUri): Promise<{ mtime: number; size: number }>;
  readFile(uri: FakeUri): Promise<Uint8Array>;
  writeFile(uri: FakeUri, content: Uint8Array): Promise<void>;
  onDidChangeFile(listener: (events: ChangeEvent[]) => void): unknown;
}

import { commandHandlers, documentCloses, editorVscode, fileSystemOptions, fileSystems, showTextDocument } from './editorVscode';

vi.mock('vscode', () => editorVscode);

import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { type CompareResult } from '../../client';
import { recordingReporter, type RecordingReporter } from '../../test/surfacingDoubles';
import { editAnswered, editorOver, forgetEditor } from './editorHarness';

type Diff = CompareResult['diffs'][number];

const diff = (fieldName: string, values: Record<string, unknown>, children?: Diff[]): Diff =>
  ({ fieldName, values, winnerColumn: '', cellStates: {}, conflictAll: 'NoConflict', noWinner: false, children });

const holder = (plugin: string, origin: string): CompareResult['overrides'][number] => ({
  formKey: '000123:Fallout4.esm', plugin, origin, isWinner: true, fields: [], recordType: 'Npc', isPartialForm: false,
  loadIndex: '00', isInOverwrite: false,
});

const comparison = (diffs: Diff[], holders: Array<[string, string]> = [['Fallout4.esm', 'Data/']]): CompareResult => ({
  overrides: holders.map(([plugin, origin]) => holder(plugin, origin)), diffs, conflictAll: 'NoConflict', recordTypeName: 'Npc', stringsLanguage: 'English',
});

const descriptionOf = (value: string) => comparison([diff('Description', { 'Fallout4.esm': value })]);

interface FieldParams {
  formKey: string; plugin: string; origin: string; path: { kind: string; name?: string; index?: number }[];
  recordLabel: string; fieldName: string; readOnly: boolean;
}

const deacon: FieldParams = {
  formKey: '000123:Fallout4.esm', plugin: 'Fallout4.esm', origin: 'Data/', path: [{ kind: 'member', name: 'Description' }],
  recordLabel: 'Deacon [000123:Fallout4.esm]', fieldName: 'Description', readOnly: false,
};

const rowsChanged = (keys: string[]) => [{ plugin: { name: 'Fallout4.esm', origin: 'Data/' }, keys }];
const pluginChanged = (plugin: string, origin: string) => [{ plugin: { name: plugin, origin } }];

let client: InMemoryMEditClient;
let reporter: RecordingReporter;

function makeDocuments() {
  const { editor, open: openTab } = editorOver({ meditClient: client, reporterOf: reporter });
  const open = async (params: FieldParams): Promise<void> => {
    await commandHandlers.get('modbench.record.openFieldValue')?.({
      webviewSection: 'stringValue', value: '', preventDefaultContextMenuItems: true, ...params,
    });
  };
  return { open, openTab, dispose: () => { editor.dispose(); } };
}

const commits = () => client.calls.filter(({ method }) => method === 'getEditChanges').map(({ args }) => args);

const isUri = (value: unknown): value is FakeUri => typeof value === 'object' && value !== null && 'path' in value && 'scheme' in value;
const shownUri = (call = -1): FakeUri => {
  const shown = showTextDocument.mock.calls.at(call)?.[0].uri;
  if (!isUri(shown)) throw new Error('nothing was shown');
  return shown;
};
const isProvider = (value: unknown): value is Provider => typeof value === 'object' && value !== null && 'readFile' in value;
const provider = (scheme = 'modbench-field'): Provider => {
  const registered = fileSystems.get(scheme);
  if (!isProvider(registered)) throw new Error(`no provider for ${scheme}`);
  return registered;
};
const textOf = async (uri: FakeUri, scheme = 'modbench-field'): Promise<string> =>
  new TextDecoder().decode(await provider(scheme).readFile(uri));
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const closeTab = (uri: FakeUri): void => { documentCloses.forEach(listener => { listener({ uri }); }); };
function recordChanges(scheme = 'modbench-field'): ChangeEvent[][] {
  const seen: ChangeEvent[][] = [];
  provider(scheme).onDidChangeFile(events => seen.push(events));
  return seen;
}

let documents: ReturnType<typeof makeDocuments>;
beforeEach(() => {
  forgetEditor();
  client = new InMemoryMEditClient();
  client.setQueryAnswer('getComparison', descriptionOf('a long description'));
  client.setQueryAnswer('getCopyDocument', { kind: 'OwnFile', location: '/source/Data/plugin-source/Fallout4.esm/Deacon.json' });
  client.setQueryAnswer('getEditChanges', editAnswered());
  reporter = recordingReporter();
  documents = makeDocuments();
});

describe('the extended-field documents', () => {
  it('opens beside the panel as a non-preview tab titled <field> [<file name>], showing the value mEdit holds', async () => {
    await documents.open(deacon);

    expect(showTextDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ viewColumn: -2, preview: false }));
    expect(shownUri().path.split('/').at(-1)).toBe('Description [Fallout4.esm]');
    expect(await textOf(shownUri())).toBe('a long description');
  });

  it('a tab restored with no open before it reads the field\'s current value', async () => {
    await documents.open(deacon);
    const restored = shownUri();
    documents.dispose();
    documents = makeDocuments();
    client.setQueryAnswer('getComparison', descriptionOf('what mEdit holds now'));

    expect(await textOf(restored)).toBe('what mEdit holds now');
  });

  it('after mEdit reports the record changed, the document reads the new value and tells VS Code it changed', async () => {
    await documents.open(deacon);
    const uri = shownUri();
    await textOf(uri);
    const changes = recordChanges();
    client.setQueryAnswer('getComparison', descriptionOf('changed elsewhere'));

    client.change(rowsChanged(['000123:Fallout4.esm']));

    expect(changes).toEqual([[{ type: 1, uri }]]);
    expect(await textOf(uri)).toBe('changed elsewhere');
  });

  it('tells VS Code the document changed with a newer version, so a clean tab reloads', async () => {
    await documents.open(deacon);
    const before = await provider().stat(shownUri());

    client.change(rowsChanged(['000123:Fallout4.esm']));

    expect((await provider().stat(shownUri())).mtime).toBeGreaterThan(before.mtime);
  });

  it('a change to another record leaves the document alone', async () => {
    await documents.open(deacon);
    await textOf(shownUri());
    const changes = recordChanges();

    client.change(rowsChanged(['000999:Fallout4.esm']));

    expect(changes).toEqual([]);
  });

  it('a change to the plugin copy it shows tells VS Code, and to another plugin does not', async () => {
    await documents.open(deacon);
    await textOf(shownUri());
    const changes = recordChanges();

    client.change(pluginChanged('Other.esp', 'Data/'));
    client.change(pluginChanged('Fallout4.esm', 'Data/'));

    expect(changes).toHaveLength(1);
  });

  it('a closed tab is told of nothing', async () => {
    await documents.open(deacon);
    await textOf(shownUri());
    const changes = recordChanges();
    closeTab(shownUri());

    client.change(rowsChanged(['000123:Fallout4.esm']));

    expect(changes).toEqual([]);
  });

  it.each([
    ['a record mEdit does not hold, naming it', deacon, null, 'FileNotFound The record 000123:Fallout4.esm is gone.'],
    ['a field the record lacks, naming the record and plugin', deacon, comparison([diff('Name', { 'Fallout4.esm': 'x' })]),
      'FileNotFound The record 000123:Fallout4.esm has no such field in Fallout4.esm.'],
    ['a plugin copy the record lacks', deacon, comparison([diff('Description', { 'Other.esp': 'x' })], [['Other.esp', 'Data/']]),
      'FileNotFound The record 000123:Fallout4.esm has no such field in Fallout4.esm.'],
    ['a plugin copy held only by a plugin of the same filename from another origin', { ...deacon, plugin: 'Shared.esp', origin: 'ModB' },
      comparison([diff('Description', { 'Shared.esp|ModA': 'x' })], [['Shared.esp', 'ModA']]),
      'FileNotFound The record 000123:Fallout4.esm has no such field in Shared.esp.'],
  ])('reads as gone %s', async (_, params, answer, message) => {
    await documents.open(params);
    client.setQueryAnswer('getComparison', answer);

    await expect(textOf(shownUri())).rejects.toThrow(message);
  });

  it('reads a nested leaf at its own index in the column', async () => {
    const leaf = diff('Name', { 'Fallout4.esm': 'second' });
    client.setQueryAnswer('getComparison', comparison([
      diff('Items', {}, [
        { ...diff('[0]', {}, [diff('Name', { 'Fallout4.esm': 'first' })]), indexes: { 'Fallout4.esm': 0 } },
        { ...diff('[1]', {}, [leaf]), indexes: { 'Fallout4.esm': 1 } },
      ]),
    ]));

    await documents.open({
      ...deacon, fieldName: 'Name',
      path: [{ kind: 'member', name: 'Items' }, { kind: 'index', index: 1 }, { kind: 'member', name: 'Name' }],
    });

    expect(await textOf(shownUri())).toBe('second');
  });

  it('each save commits the saved text at the cell\'s address, every time', async () => {
    await documents.open(deacon);

    await provider().writeFile(shownUri(), encode('first'));
    await provider().writeFile(shownUri(), encode('second'));

    const plugin = { name: 'Fallout4.esm', origin: 'Data/' };
    expect(commits()).toEqual([
      [deacon.formKey, plugin, { op: 'set', path: deacon.path, value: 'first' }],
      [deacon.formKey, plugin, { op: 'set', path: deacon.path, value: 'second' }],
    ]);
  });

  it('a save after an edit of the FormID moved the record lands at the FormKey the record is at now', async () => {
    const moved = { ...deacon, formKey: '000800:A.esp', plugin: 'A.esp', origin: 'ModA' };
    documents.openTab(moved.formKey);
    client.setQueryAnswerOnce('getEditChanges', editAnswered({ newFormKey: '000900:A.esp' }));
    await commandHandlers.get('modbench.record.editField')?.(
      { formKey: moved.formKey, plugin: moved.plugin, origin: moved.origin }, { op: 'set', path: [{ kind: 'member', name: 'FormID' }], value: '000900' });
    await documents.open(moved);

    await provider().writeFile(shownUri(), encode('saved'));

    expect(commits().map(([formKey]) => formKey)).toEqual(['000800:A.esp', '000900:A.esp']);
  });

  it('closing without saving commits nothing', async () => {
    await documents.open(deacon);
    await textOf(shownUri());

    closeTab(shownUri());

    expect(commits()).toEqual([]);
  });

  it('a multi-line value reads back byte for byte', async () => {
    const multiline = 'First line.\nSecond line.\n\nFourth line.';
    client.setQueryAnswer('getComparison', descriptionOf(multiline));
    await documents.open(deacon);

    expect(await textOf(shownUri())).toBe(multiline);
  });

  it('opening the same cell again shows the same document', async () => {
    await documents.open(deacon);
    await documents.open(deacon);

    expect(shownUri(0).toString()).toBe(shownUri(1).toString());
  });

  it('two columns sharing a filename but differing in origin are two documents, each reading its own column', async () => {
    client.setQueryAnswer('getComparison', comparison(
      [diff('Description', { 'Shared.esp|ModA': 'from ModA', 'Shared.esp|ModB': 'from ModB' })],
      [['Shared.esp', 'ModA'], ['Shared.esp', 'ModB']],
    ));
    await documents.open({ ...deacon, plugin: 'Shared.esp', origin: 'ModA' });
    await documents.open({ ...deacon, plugin: 'Shared.esp', origin: 'ModB' });

    expect(shownUri(0).toString()).not.toBe(shownUri(1).toString());
    expect(await textOf(shownUri(0))).toBe('from ModA');
    expect(await textOf(shownUri(1))).toBe('from ModB');
  });

  it('a slash in a label cannot change which segment is the tab\'s title', async () => {
    await documents.open({ ...deacon, fieldName: 'A/B' });

    expect(shownUri().path.split('/').at(-1)).toBe('A_B [Fallout4.esm]');
  });

  it('reports an error when opening fails', async () => {
    showTextDocument.mockRejectedValueOnce(new Error('no window'));

    await documents.open(deacon);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not open the extended editor.', detail: 'no window' }]);
  });

  it.each([
    ['can be edited', false, 'modbench-field'],
    ['cannot be edited', true, 'modbench-field-readonly'],
  ])('opens a field of a column that %s under its scheme', async (_, readOnly, scheme) => {
    await documents.open({ ...deacon, readOnly });

    expect(shownUri().scheme).toBe(scheme);
  });

  describe('in a column that cannot be edited', () => {
    it('registers the read-only scheme read-only, and the editable one not', async () => {
      await documents.open({ ...deacon, readOnly: true });

      expect(fileSystemOptions.get('modbench-field-readonly')).toEqual({ isReadonly: true });
      expect(fileSystemOptions.get('modbench-field')).toBeUndefined();
    });

    it('shows the value, refuses a write and commits nothing', async () => {
      await documents.open({ ...deacon, readOnly: true });

      expect(await textOf(shownUri(), 'modbench-field-readonly')).toBe('a long description');
      await expect(provider('modbench-field-readonly').writeFile(shownUri(), encode('x'))).rejects.toThrow('NoPermissions');
      expect(commits()).toEqual([]);
    });
  });

  it('disposing unregisters both schemes', () => {
    documents.dispose();

    expect([fileSystems.has('modbench-field'), fileSystems.has('modbench-field-readonly')]).toEqual([false, false]);
  });
});
