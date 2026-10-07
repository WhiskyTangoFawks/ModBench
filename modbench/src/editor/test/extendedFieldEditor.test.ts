import type { NotificationEvent } from '../../client/apiClient';
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeUri { scheme: string; path: string; query: string; toString(): string }
interface ChangeEvent { type: number; uri: FakeUri }
interface Provider {
  stat(uri: FakeUri): Promise<{ mtime: number; size: number }>;
  readFile(uri: FakeUri): Promise<Uint8Array>;
  writeFile(uri: FakeUri, content: Uint8Array): Promise<void>;
  onDidChangeFile(listener: (events: ChangeEvent[]) => void): unknown;
}
interface Registration { provider: Provider; options?: { isReadonly?: boolean } }

const providers = new Map<string, Registration>();
const closeListeners: Array<(doc: { uri: FakeUri }) => void> = [];
const showTextDocument = vi.fn<(doc: { uri: FakeUri }, opts?: unknown) => Promise<unknown>>();

vi.mock('vscode', () => ({
  workspace: {
    registerFileSystemProvider: (scheme: string, provider: Provider, options?: { isReadonly?: boolean }) => {
      providers.set(scheme, { provider, options });
      return { dispose: () => providers.delete(scheme) };
    },
    onDidCloseTextDocument: (listener: (doc: { uri: FakeUri }) => void) => {
      closeListeners.push(listener);
      return { dispose: () => undefined };
    },
    openTextDocument: (uri: FakeUri) => Promise.resolve({ uri }),
  },
  window: { showTextDocument: (doc: { uri: FakeUri }, opts?: unknown) => showTextDocument(doc, opts) },
  Uri: {
    from: (parts: { scheme: string; path: string; query: string }): FakeUri => ({
      ...parts, toString: () => `${parts.scheme}://${parts.path}?${parts.query}`,
    }),
  },
  EventEmitter: class {
    private readonly listeners: Array<(e: unknown) => void> = [];
    event = (listener: (e: unknown) => void) => { this.listeners.push(listener); return { dispose: () => undefined }; };
    fire(e: unknown) { this.listeners.forEach(l => l(e)); }
    dispose() { this.listeners.length = 0; }
  },
  Disposable: class { constructor(public dispose: () => void) {} },
  FileType: { File: 1 },
  FileChangeType: { Changed: 1 },
  FileSystemError: {
    FileNotFound: (what: FakeUri | string) => new Error(`FileNotFound ${typeof what === 'string' ? what : what.path}`),
    NoPermissions: (uri: FakeUri) => new Error(`NoPermissions ${uri.path}`),
  },
  ViewColumn: { Beside: -2 },
}));

import { ExtendedFieldDocuments, type OpenExtendedFieldEditorParams } from '../extendedFieldEditor';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { type CompareResult } from '../../client';
import type { Reporter } from '../../ports/reporter';

type Diff = CompareResult['diffs'][number];

const diff = (fieldName: string, values: Record<string, unknown>, children?: Diff[]): Diff =>
  ({ fieldName, values, winnerColumn: '', cellStates: {}, conflictAll: 'NoConflict', children });

const holder = (plugin: string, origin: string): CompareResult['overrides'][number] => ({
  formKey: '000123:Fallout4.esm', plugin, origin, isWinner: true, fields: [], recordType: 'Npc', isPartialForm: false,
  loadIndex: '00', isInOverwrite: false,
});

const comparison = (diffs: Diff[], holders: Array<[string, string]> = [['Fallout4.esm', 'Data']]): CompareResult => ({
  overrides: holders.map(([plugin, origin]) => holder(plugin, origin)), diffs, conflictAll: 'NoConflict', recordTypeName: 'Npc',
});

const descriptionOf = (value: string) => comparison([diff('Description', { 'Fallout4.esm': value })]);

const deacon: OpenExtendedFieldEditorParams = {
  formKey: '000123:Fallout4.esm', plugin: 'Fallout4.esm', origin: 'Data', path: [{ kind: 'member', name: 'Description' }],
  recordLabel: 'Deacon [000123:Fallout4.esm]', fieldName: 'Description', readOnly: false,
};

const rowsChanged = (keys: string[]): NotificationEvent =>
  ({ kind: 'rows-changed', plugin: 'Fallout4.esm', origin: 'Data', keys, sequence: 1 });
const pluginChanged = (plugin: string, origin: string): NotificationEvent =>
  ({ kind: 'plugin-changed', plugin, origin, keys: [], sequence: 1 });

let client: InMemoryMEditClient;
let report: ReturnType<typeof vi.fn<Reporter['report']>>;
let commit: ReturnType<typeof vi.fn<(field: unknown, value: string) => Promise<void>>>;

function makeDocuments(): ExtendedFieldDocuments {
  return new ExtendedFieldDocuments({
    client, commit,
    reporter: { report, landed: vi.fn(), shownOnSurface: vi.fn(), selectionOutcome: vi.fn() },
  });
}

const shownUri = (call = -1): FakeUri => {
  const shown = showTextDocument.mock.calls.at(call);
  if (!shown) throw new Error('nothing was shown');
  return shown[0].uri;
};
const registration = (scheme: string): Registration => {
  const reg = providers.get(scheme);
  if (!reg) throw new Error(`no provider for ${scheme}`);
  return reg;
};
const provider = (scheme = 'modbench-field'): Provider => registration(scheme).provider;
const textOf = async (uri: FakeUri, scheme = 'modbench-field'): Promise<string> =>
  new TextDecoder().decode(await provider(scheme).readFile(uri));
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const closeTab = (uri: FakeUri): void => closeListeners.forEach(listener => listener({ uri }));
function recordChanges(scheme = 'modbench-field'): ChangeEvent[][] {
  const seen: ChangeEvent[][] = [];
  provider(scheme).onDidChangeFile(events => seen.push(events));
  return seen;
}

let documents: ExtendedFieldDocuments;
beforeEach(() => {
  providers.clear();
  closeListeners.length = 0;
  showTextDocument.mockReset();
  showTextDocument.mockResolvedValue(undefined);
  client = new InMemoryMEditClient();
  client.setQueryAnswer('getComparison', descriptionOf('a long description'));
  report = vi.fn();
  commit = vi.fn(() => Promise.resolve());
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
    providers.clear();
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

    client.emit(rowsChanged(['000123:Fallout4.esm']));

    expect(changes).toEqual([[{ type: 1, uri }]]);
    expect(await textOf(uri)).toBe('changed elsewhere');
  });

  it('tells VS Code the document changed with a newer version, so a clean tab reloads', async () => {
    await documents.open(deacon);
    const before = await provider().stat(shownUri());

    client.emit(rowsChanged(['000123:Fallout4.esm']));

    expect((await provider().stat(shownUri())).mtime).toBeGreaterThan(before.mtime);
  });

  it('a change to another record leaves the document alone', async () => {
    await documents.open(deacon);
    await textOf(shownUri());
    const changes = recordChanges();

    client.emit(rowsChanged(['000999:Fallout4.esm']));

    expect(changes).toEqual([]);
  });

  it('a change to the plugin copy it shows tells VS Code, and to another plugin does not', async () => {
    await documents.open(deacon);
    await textOf(shownUri());
    const changes = recordChanges();

    client.emit(pluginChanged('Other.esp', 'Data'));
    client.emit(pluginChanged('Fallout4.esm', 'Data'));

    expect(changes).toHaveLength(1);
  });

  it('when the stream of mEdit\'s reports opens again, every open document in either scheme tells VS Code it changed', async () => {
    await documents.open(deacon);
    await documents.open({ ...deacon, readOnly: true });
    const [editable, readOnly] = [shownUri(0), shownUri(1)];
    await textOf(editable);
    await textOf(readOnly, 'modbench-field-readonly');
    const changes = [recordChanges(), recordChanges('modbench-field-readonly')];

    client.reconnected();

    expect(changes).toEqual([[[{ type: 1, uri: editable }]], [[{ type: 1, uri: readOnly }]]]);
  });

  it('a closed tab is told of nothing', async () => {
    await documents.open(deacon);
    await textOf(shownUri());
    const changes = recordChanges();
    closeTab(shownUri());

    client.emit(rowsChanged(['000123:Fallout4.esm']));

    expect(changes).toEqual([]);
  });

  it('a record mEdit does not hold reads as gone, naming it', async () => {
    await documents.open(deacon);
    client.setQueryAnswer('getComparison', null);

    await expect(textOf(shownUri())).rejects.toThrow('FileNotFound The record 000123:Fallout4.esm is gone.');
  });

  it('a field the record lacks reads as gone, naming the record and plugin', async () => {
    await documents.open(deacon);
    client.setQueryAnswer('getComparison', comparison([diff('Name', { 'Fallout4.esm': 'x' })]));

    await expect(textOf(shownUri())).rejects.toThrow('FileNotFound The record 000123:Fallout4.esm has no such field in Fallout4.esm.');
  });

  it('a plugin copy the record lacks reads as gone', async () => {
    await documents.open(deacon);
    client.setQueryAnswer('getComparison', comparison([diff('Description', { 'Other.esp': 'x' })], [['Other.esp', 'Data']]));

    await expect(textOf(shownUri())).rejects.toThrow('has no such field');
  });

  it('a plugin copy held only by a plugin of the same filename from another origin reads as gone', async () => {
    client.setQueryAnswer('getComparison', comparison(
      [diff('Description', { 'Shared.esp|ModA': 'x' })], [['Shared.esp', 'ModA']]));
    await documents.open({ ...deacon, plugin: 'Shared.esp', origin: 'ModB' });

    await expect(textOf(shownUri())).rejects.toThrow('has no such field');
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

    const address = { formKey: deacon.formKey, plugin: { name: 'Fallout4.esm', origin: 'Data' }, path: deacon.path };
    expect(commit.mock.calls).toEqual([[address, 'first'], [address, 'second']]);
  });

  it('closing without saving commits nothing', async () => {
    await documents.open(deacon);
    await textOf(shownUri());

    closeTab(shownUri());

    expect(commit).not.toHaveBeenCalled();
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

    expect(report).toHaveBeenCalledWith('error', 'Could not open the extended editor.', 'no window');
  });

  describe('in a column that cannot be edited', () => {
    it('opens under the read-only scheme, registered read-only, and the editable one is not', async () => {
      await documents.open({ ...deacon, readOnly: true });

      expect(shownUri().scheme).toBe('modbench-field-readonly');
      expect(registration('modbench-field-readonly').options).toEqual({ isReadonly: true });
      expect(registration('modbench-field').options).toBeUndefined();
    });

    it('shows the value, refuses a write and commits nothing', async () => {
      await documents.open({ ...deacon, readOnly: true });

      expect(await textOf(shownUri(), 'modbench-field-readonly')).toBe('a long description');
      await expect(provider('modbench-field-readonly').writeFile(shownUri(), encode('x'))).rejects.toThrow('NoPermissions');
      expect(commit).not.toHaveBeenCalled();
    });
  });

  it('disposing unregisters both schemes', () => {
    documents.dispose();

    expect([...providers.keys()]).toEqual([]);
  });
});
