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

import { RenderedDocuments, renderedCopyOf, renderedDocumentUri } from '../renderedDocument';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

interface ContentProvider {
  provideTextDocumentContent(uri: unknown): Promise<string>;
  onDidChange(listener: (uri: unknown) => void): unknown;
}

const isContentProvider = (value: unknown): value is ContentProvider =>
  typeof value === 'object' && value !== null && 'provideTextDocumentContent' in value && 'onDidChange' in value;

const GUN = '000801:A.esp';
const modA = { name: 'A.esp', origin: 'ModA' };
const copy = { formKey: GUN, plugin: modA };
const NAME = 'Gun - 000801_A.esp.json';

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

describe('a rendered document\'s address', () => {
  it('names the copy by its FormKey and plugin, and ends in the name its file would have', () => {
    const uri = renderedDocumentUri(copy, NAME);

    expect(renderedCopyOf(uri)).toEqual(copy);
    expect(uri.path.split('/').at(-1)).toBe(NAME);
  });

  it('survives a plugin address containing "/"', () => {
    const odd = { formKey: '000801:Mod/A.esp', plugin: { name: 'Mod/A.esp', origin: 'Mods/A' } };

    expect(renderedCopyOf(renderedDocumentUri(odd, NAME))).toEqual(odd);
  });

  it('refuses an address that states no plugin name, naming what it lacks', () => {
    const uri = { scheme: 'modbench-rendered', path: '/ModA/A.esp/Gun.json', query: 'formKey=000801%3AA.esp&origin=ModA' };

    expect(() => renderedCopyOf(uri)).toThrow('The rendered document /ModA/A.esp/Gun.json states no name.');
  });

  it('tells apart the copies of two plugins of one file name from different origins', () => {
    expect(renderedDocumentUri(copy, NAME))
      .not.toEqual(renderedDocumentUri({ formKey: GUN, plugin: { name: 'A.esp', origin: 'ModB' } }, NAME));
  });
});

describe('a rendered document\'s text', () => {
  it('is the text mEdit renders the copy as', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getRenderedDocument', { fileName: NAME, text: '{ "EditorID": "Gun" }' });
    const { provider } = rendered(client);

    await expect(provider.provideTextDocumentContent(renderedDocumentUri(copy, NAME))).resolves.toBe('{ "EditorID": "Gun" }');
    expect(client.calls).toContainEqual({ method: 'getRenderedDocument', args: [modA, GUN] });
  });

  it('refuses, naming the copy, when the plugin holds none', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getRenderedDocument', null);
    const { provider } = rendered(client);

    await expect(provider.provideTextDocumentContent(renderedDocumentUri(copy, NAME)))
      .rejects.toThrow(`A.esp (ModA) holds no ${GUN}.`);
  });
});

describe('an open rendered document, when mEdit reports a change', () => {
  const rowsChanged = (plugin: { name: string; origin: string }, keys: string[]) =>
    ({ kind: 'rows-changed', plugin: plugin.name, origin: plugin.origin, keys, sequence: 1 });

  it('changes when its plugin\'s rows that changed hold its record', () => {
    const client = new InMemoryMEditClient();
    const { changed } = rendered(client);
    const uri = renderedDocumentUri(copy, NAME);
    h.textDocuments.push({ uri }, { uri: renderedDocumentUri({ formKey: '000802:A.esp', plugin: modA }, 'Other.json') });

    client.emit(rowsChanged(modA, [GUN]));

    expect(changed).toEqual([uri]);
  });

  it('stays as it is when another plugin\'s copy of its record changed', () => {
    const client = new InMemoryMEditClient();
    const { changed } = rendered(client);
    h.textDocuments.push({ uri: renderedDocumentUri(copy, NAME) });

    client.emit(rowsChanged({ name: 'A.esp', origin: 'ModB' }, [GUN]));

    expect(changed).toEqual([]);
  });

  it('changes, every one, when the stream of mEdit\'s reports opens again', () => {
    const client = new InMemoryMEditClient();
    const { changed } = rendered(client);
    const [gun, other] = [renderedDocumentUri(copy, NAME), renderedDocumentUri({ formKey: GUN, plugin: { name: 'B.esp', origin: 'ModB' } }, NAME)];
    h.textDocuments.push({ uri: gun }, { uri: other }, { uri: { scheme: 'file', path: gun.path, query: gun.query } });

    client.reconnected();

    expect(changed).toEqual([gun, other]);
  });

  it('changes when mEdit read its plugin again whole', () => {
    const client = new InMemoryMEditClient();
    const { changed } = rendered(client);
    const uri = renderedDocumentUri(copy, NAME);
    h.textDocuments.push({ uri }, { uri: { scheme: 'file', path: uri.path, query: uri.query } });

    client.emit({ kind: 'plugin-changed', plugin: 'A.esp', origin: 'ModA', keys: [], sequence: 1 });

    expect(changed).toEqual([uri]);
  });
});
