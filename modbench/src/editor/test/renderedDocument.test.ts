import { describe, it, expect, vi, beforeEach } from 'vitest';
import { contentProviders, editorVscode, textDocuments } from './editorVscode';

vi.mock('vscode', () => editorVscode);

import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { editorOver, forgetEditor } from './editorHarness';

interface ContentProvider {
  provideTextDocumentContent(uri: unknown): Promise<string>;
  onDidChange(listener: (uri: unknown) => void): unknown;
}

const isContentProvider = (value: unknown): value is ContentProvider =>
  typeof value === 'object' && value !== null && 'provideTextDocumentContent' in value && 'onDidChange' in value;

const GUN = '000801:A.esp';
const modA = { name: 'A.esp', origin: 'ModA' };
const NAME = 'Gun - 000801_A.esp.json';
const renderedUri = (path: string, query: string) => editorVscode.Uri.from({ scheme: 'modbench-rendered', path, query });
const GUN_URI = renderedUri(`/ModA/A.esp/${NAME}`, 'formKey=000801%3AA.esp&name=A.esp&origin=ModA');

function rendered(client = new InMemoryMEditClient()) {
  editorOver({ meditClient: client });
  const provider = contentProviders.get('modbench-rendered');
  if (!isContentProvider(provider)) throw new Error('no content provider registered');
  const changed: unknown[] = [];
  provider.onDidChange((uri) => changed.push(uri));
  return { provider, changed };
}

beforeEach(forgetEditor);

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
  const rowsChanged = (plugin: { name: string; origin: string }, keys: string[]) => [{ plugin: { name: plugin.name, origin: plugin.origin }, keys }];

  it('changes when its plugin\'s rows that changed hold its record', () => {
    const client = new InMemoryMEditClient();
    const { changed } = rendered(client);
    const uri = GUN_URI;
    textDocuments.push({ uri }, { uri: renderedUri('/ModA/A.esp/Other.json', 'formKey=000802%3AA.esp&name=A.esp&origin=ModA') });

    client.change(rowsChanged(modA, [GUN]));

    expect(changed).toEqual([uri]);
  });

  it('stays as it is when another plugin\'s copy of its record changed', () => {
    const client = new InMemoryMEditClient();
    const { changed } = rendered(client);
    textDocuments.push({ uri: GUN_URI });

    client.change(rowsChanged({ name: 'A.esp', origin: 'ModB' }, [GUN]));

    expect(changed).toEqual([]);
  });

  it('changes when mEdit read its plugin again whole', () => {
    const client = new InMemoryMEditClient();
    const { changed } = rendered(client);
    const uri = GUN_URI;
    textDocuments.push({ uri }, { uri: { scheme: 'file', path: `/ModA/A.esp/${NAME}`, query: 'formKey=000801%3AA.esp&name=A.esp&origin=ModA' } });

    client.change([{ plugin: { name: 'A.esp', origin: 'ModA' } }]);

    expect(changed).toEqual([uri]);
  });
});
