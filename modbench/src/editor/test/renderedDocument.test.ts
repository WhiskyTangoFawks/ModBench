import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter, uriFrom } from '../../test/vscodeMock';

const h = vi.hoisted(() => ({
  providers: new Map<string, unknown>(),
  textDocuments: [] as { uri: unknown }[],
}));

vi.mock('vscode', () => ({
  EventEmitter,
  Uri: { from: uriFrom },
  Disposable: class { constructor(public dispose: () => void) {} },
  workspace: {
    registerTextDocumentContentProvider: (scheme: string, provider: unknown) => {
      h.providers.set(scheme, provider);
      return { dispose: () => h.providers.delete(scheme) };
    },
    get textDocuments() { return h.textDocuments; },
  },
}));

import { RenderedDocuments } from '../renderedDocument';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { notificationEventFixture } from '../../client/test/fixtures';

interface ContentProvider {
  provideTextDocumentContent(uri: unknown): Promise<string>;
  onDidChange(listener: (uri: unknown) => void): unknown;
}

const isContentProvider = (value: unknown): value is ContentProvider =>
  typeof value === 'object' && value !== null && 'provideTextDocumentContent' in value && 'onDidChange' in value;

const GUN = '000801:A.esp';
const modA = { name: 'A.esp', origin: 'ModA' };
const NAME = 'Gun - 000801_A.esp.json';
const renderedUri = (path: string, query: string) => uriFrom({ scheme: 'modbench-rendered', path, query });
const GUN_URI = renderedUri(`/ModA/A.esp/${NAME}`, 'formKey=000801%3AA.esp&name=A.esp&origin=ModA');

function rendered(client = new InMemoryMEditClient()) {
  const documents = new RenderedDocuments(client);
  const [provider] = h.providers.values();
  if (!isContentProvider(provider)) throw new Error('no content provider registered');
  const changed: unknown[] = [];
  provider.onDidChange((uri) => changed.push(uri));
  return { documents, provider, changed };
}

beforeEach(() => {
  h.providers.clear();
  h.textDocuments.length = 0;
});

describe('a rendered document\'s text', () => {
  it('is the text mEdit renders the copy as', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getRenderedDocument', { fileName: NAME, text: '{ "EditorID": "Gun" }' });
    const { provider } = rendered(client);

    await expect(provider.provideTextDocumentContent(GUN_URI)).resolves.toBe('{ "EditorID": "Gun" }');
    expect(client.calls).toContainEqual({ method: 'getRenderedDocument', args: [modA, GUN] });
  });

  it('refuses, naming the copy, when mEdit renders none', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getRenderedDocument', null);
    const { provider } = rendered(client);

    await expect(provider.provideTextDocumentContent(GUN_URI)).rejects.toThrow('A.esp (ModA) holds no 000801:A.esp.');
  });
});

describe('an open rendered document, when mEdit reports a change', () => {
  const rowsChanged = (plugin: { name: string; origin: string }, keys: string[]) =>
    notificationEventFixture({ kind: 'rows-changed', plugin: plugin.name, origin: plugin.origin, keys });

  it('changes when its plugin\'s rows that changed hold its record', () => {
    const client = new InMemoryMEditClient();
    const { changed } = rendered(client);
    const uri = GUN_URI;
    h.textDocuments.push({ uri }, { uri: renderedUri('/ModA/A.esp/Other.json', 'formKey=000802%3AA.esp&name=A.esp&origin=ModA') });

    client.emit(rowsChanged(modA, [GUN]));

    expect(changed).toEqual([uri]);
  });

  it('stays as it is when another plugin\'s copy of its record changed', () => {
    const client = new InMemoryMEditClient();
    const { changed } = rendered(client);
    h.textDocuments.push({ uri: GUN_URI });

    client.emit(rowsChanged({ name: 'A.esp', origin: 'ModB' }, [GUN]));

    expect(changed).toEqual([]);
  });

  it('changes when mEdit read its plugin again whole', () => {
    const client = new InMemoryMEditClient();
    const { changed } = rendered(client);
    const uri = GUN_URI;
    h.textDocuments.push({ uri }, { uri: { scheme: 'file', path: uri.path, query: uri.query } });

    client.emit(notificationEventFixture({ kind: 'plugin-changed', plugin: 'A.esp', origin: 'ModA' }));

    expect(changed).toEqual([uri]);
  });
});
