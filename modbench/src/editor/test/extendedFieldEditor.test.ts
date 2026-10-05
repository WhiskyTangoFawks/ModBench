import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeUri { scheme: string; path: string; query: string; toString(): string }
interface Provider {
  stat(uri: FakeUri): { mtime: number; size: number };
  readFile(uri: FakeUri): Uint8Array;
  writeFile(uri: FakeUri, content: Uint8Array): Promise<void>;
}
interface Registration { provider: Provider; options?: { isReadonly?: boolean } }

const providers = new Map<string, Registration>();
const closeListeners: Array<(doc: { uri: FakeUri }) => void> = [];
const showTextDocument = vi.fn<(doc: unknown, opts?: unknown) => Promise<unknown>>();

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
  window: { showTextDocument: (doc: unknown, opts?: unknown) => showTextDocument(doc, opts) },
  Uri: {
    from: (parts: { scheme: string; path: string; query: string }): FakeUri => ({
      ...parts, toString: () => `${parts.scheme}://${parts.path}?${parts.query}`,
    }),
  },
  EventEmitter: class { event = () => ({ dispose: () => undefined }); },
  Disposable: class { constructor(public dispose: () => void) {} },
  FileType: { File: 1 },
  FileSystemError: {
    FileNotFound: (uri: FakeUri) => new Error(`FileNotFound ${uri.path}`),
    NoPermissions: (uri: FakeUri) => new Error(`NoPermissions ${uri.path}`),
  },
  ViewColumn: { Beside: -2 },
}));

import { ExtendedFieldDocuments, EDITABLE_FIELD_SCHEME, READONLY_FIELD_SCHEME, type ExtendedFieldEditorDeps } from '../extendedFieldEditor';

const deacon = {
  value: 'a long description', recordLabel: 'Deacon [000123:Fallout4.esm]', fieldName: 'Description',
  plugin: 'Fallout4.esm', origin: 'Data', readOnly: false,
};

function makeDeps(overrides: Partial<ExtendedFieldEditorDeps> = {}): ExtendedFieldEditorDeps {
  return {
    onCommit: vi.fn(),
    reporter: { report: vi.fn(), landed: vi.fn(), shownOnSurface: vi.fn(), selectionOutcome: vi.fn() },
    ...overrides,
  };
}

const shownUri = (call = -1): FakeUri =>
  (showTextDocument.mock.calls.at(call)?.[0] as { uri: FakeUri }).uri;
const text = (reg: Registration, uri: FakeUri): string => new TextDecoder().decode(reg.provider.readFile(uri));
const registration = (scheme: string): Registration => {
  const reg = providers.get(scheme);
  if (!reg) throw new Error(`no provider for ${scheme}`);
  return reg;
};

let documents: ExtendedFieldDocuments;
beforeEach(() => {
  providers.clear();
  closeListeners.length = 0;
  showTextDocument.mockReset();
  showTextDocument.mockResolvedValue(undefined);
  documents = new ExtendedFieldDocuments();
});

describe('the extended-field documents', () => {
  it('opens the cell\'s value beside the panel as a non-preview tab titled <field> [<file name>]', async () => {
    await documents.open(deacon, makeDeps());

    expect(showTextDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ viewColumn: -2, preview: false }));
    expect(shownUri().path.split('/').at(-1)).toBe('Description [Fallout4.esm]');
    expect(text(registration(EDITABLE_FIELD_SCHEME), shownUri())).toBe('a long description');
  });

  it('each save writes the saved text through onCommit, every time', async () => {
    const deps = makeDeps();
    await documents.open(deacon, deps);
    const { provider } = registration(EDITABLE_FIELD_SCHEME);

    await provider.writeFile(shownUri(), new TextEncoder().encode('first'));
    await provider.writeFile(shownUri(), new TextEncoder().encode('second'));

    expect(deps.onCommit).toHaveBeenNthCalledWith(1, 'first');
    expect(deps.onCommit).toHaveBeenNthCalledWith(2, 'second');
  });

  it('closing without saving writes nothing', async () => {
    const deps = makeDeps();
    await documents.open(deacon, deps);

    closeListeners.forEach(listener => listener({ uri: shownUri() }));

    expect(deps.onCommit).not.toHaveBeenCalled();
  });

  it('a multi-line value reads back byte for byte', async () => {
    const multiline = 'First line.\nSecond line.\n\nFourth line.';
    await documents.open({ ...deacon, value: multiline }, makeDeps());

    expect(text(registration(EDITABLE_FIELD_SCHEME), shownUri())).toBe(multiline);
  });

  it('opened again while its tab is open, shows the same document and keeps the text in it', async () => {
    await documents.open(deacon, makeDeps());
    const { provider } = registration(EDITABLE_FIELD_SCHEME);
    await provider.writeFile(shownUri(), new TextEncoder().encode('saved edit'));

    await documents.open({ ...deacon, value: 'newer' }, makeDeps());

    expect(shownUri(0).toString()).toBe(shownUri(1).toString());
    expect(text(registration(EDITABLE_FIELD_SCHEME), shownUri())).toBe('saved edit');
  });

  it('opened again after its tab closed, reads the value afresh', async () => {
    await documents.open(deacon, makeDeps());
    closeListeners.forEach(listener => listener({ uri: shownUri() }));

    await documents.open({ ...deacon, value: 'again' }, makeDeps());

    expect(text(registration(EDITABLE_FIELD_SCHEME), shownUri())).toBe('again');
  });

  it('a document that is not open reads as missing, never as a stale value', async () => {
    await documents.open(deacon, makeDeps());
    const uri = shownUri();
    closeListeners.forEach(listener => listener({ uri }));

    expect(() => registration(EDITABLE_FIELD_SCHEME).provider.readFile(uri)).toThrow('FileNotFound');
  });

  it('two columns sharing a filename but differing in origin are two documents', async () => {
    await documents.open({ ...deacon, plugin: 'Shared.esp', origin: 'ModA', value: 'from ModA' }, makeDeps());
    await documents.open({ ...deacon, plugin: 'Shared.esp', origin: 'ModB', value: 'from ModB' }, makeDeps());

    const reg = registration(EDITABLE_FIELD_SCHEME);
    expect(shownUri(0).toString()).not.toBe(shownUri(1).toString());
    expect(text(reg, shownUri(0))).toBe('from ModA');
    expect(text(reg, shownUri(1))).toBe('from ModB');
  });

  it('a slash in a label cannot change which segment is the tab\'s title', async () => {
    await documents.open({ ...deacon, fieldName: 'A/B' }, makeDeps());

    expect(shownUri().path.split('/').at(-1)).toBe('A_B [Fallout4.esm]');
  });

  it('reports an error and leaves no document behind when opening fails', async () => {
    showTextDocument.mockRejectedValueOnce(new Error('no window'));
    const deps = makeDeps();

    await documents.open(deacon, deps);

    expect(deps.reporter.report).toHaveBeenCalledWith('error', 'Could not open the extended editor.', 'no window');
    await documents.open(deacon, makeDeps());
    expect(text(registration(EDITABLE_FIELD_SCHEME), shownUri())).toBe('a long description');
  });

  describe('in a column that cannot be edited', () => {
    it('opens under the read-only scheme, registered read-only, and the editable one is not', async () => {
      await documents.open({ ...deacon, readOnly: true }, makeDeps());

      expect(shownUri().scheme).toBe(READONLY_FIELD_SCHEME);
      expect(registration(READONLY_FIELD_SCHEME).options).toEqual({ isReadonly: true });
      expect(registration(EDITABLE_FIELD_SCHEME).options).toBeUndefined();
    });

    it('refuses a write and commits nothing', async () => {
      const deps = makeDeps();
      await documents.open({ ...deacon, readOnly: true }, deps);

      await expect(registration(READONLY_FIELD_SCHEME).provider.writeFile(shownUri(), new TextEncoder().encode('x')))
        .rejects.toThrow('NoPermissions');
      expect(deps.onCommit).not.toHaveBeenCalled();
    });
  });

  it('disposing unregisters both schemes', () => {
    documents.dispose();

    expect([...providers.keys()]).toEqual([]);
  });
});
