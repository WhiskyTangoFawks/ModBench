import { describe, it, expect, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';
import { CompletionItemKind, SymbolKind } from './iconsMock';

const setInput = vi.hoisted(() => vi.fn<(input: { location: { uri: { path: string }; range: unknown } }) => void>());
vi.mock('vscode', () => ({
  extensions: { getExtension: () => ({ activate: () => Promise.resolve({ setInput }) }) },
  Uri, SymbolKind, CompletionItemKind, TreeItem, TreeItemCollapsibleState,
  Position: class { constructor(readonly line: number, readonly character: number) {} },
  Range: class { constructor(readonly start: unknown, readonly end: unknown) {} },
  Location: class { constructor(readonly uri: unknown, readonly range: unknown) {} },
}));

import * as vscode from 'vscode';
import { recordLanguage } from '../recordLanguage';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { recordingReporter } from '../../test/surfacingDoubles';
import { localFailure } from '../../wire/readFailed';
import { sourceNames, spelledIn } from './fakeSourceNames';
import { COMPLETION, SEARCH } from './fakeKinds';
import { present } from '../../ports/present';
import { pluginMetadataFixture } from '../../client/test/fixtures';

const GUN = '000801:A.esp';
const modA = { name: 'A.esp', origin: 'ModA' };
const GUN_FILE = '/source/ModA/plugin-source/A.esp/Weapons/Gun.json';
const GUN_TEXT = `{\n  "FormKey": "${GUN}",\n  "EditorID": "Gun"\n}`;
const RECORD = { kind: 'record', formKey: GUN } as const;

function kind({ open = (): Promise<{ getText(): string }> => Promise.resolve({ getText: () => GUN_TEXT }) } = {}) {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getRecordOwner', modA);
  client.setQueryAnswer('getCopyDocument', { kind: 'OwnFile', location: GUN_FILE });
  const opened: unknown[] = [];
  const reporter = recordingReporter();
  const record = recordLanguage({
    client, reporter, names: sourceNames({
      declarationIn: (text: string, formKey: string) => Promise.resolve(spelledIn(text, `"FormKey": "${formKey}"`)),
      formKeyIn: (text: string, formKey: string) => Promise.resolve(spelledIn(text, `"${formKey}"`)),
    }),
    open: async (uri: vscode.Uri) => { opened.push(uri); return { ...await open(), positionAt: (offset: number) => new vscode.Position(0, offset) }; },
  });
  return { client, opened, record, reporter };
}

describe('where a record is defined (symbols.md, The symbols, Record)', () => {
  it('is the winning copy\'s file at the record\'s own FormKey member', async () => {
    const member = GUN_TEXT.indexOf(`"FormKey": "${GUN}"`);

    expect(await kind().record.definitionOf(RECORD)).toMatchObject({
      at: { uri: { scheme: 'file', path: GUN_FILE }, range: { start: { character: member }, end: { character: member + `"FormKey": "${GUN}"`.length } } },
    });
  });

  it.each([
    ['the record\'s document states no FormKey member for it', () => kind({ open: () => Promise.resolve({ getText: () => '{ "EditorID": "Gun" }' }) }), `${GUN_FILE} states no ${GUN} member.`],
    ['no active plugin holds it', (k: ReturnType<typeof kind>) => { k.client.setQueryAnswer('getRecordOwner', undefined); return k; }, `No active plugin holds ${GUN}.`],
    ['the winning plugin holds no copy', (k: ReturnType<typeof kind>) => { k.client.setQueryAnswer('getCopyDocument', null); return k; }, `A.esp (ModA) holds no ${GUN}.`],
    ['its document fails to open', () => kind({ open: () => Promise.reject(new Error('The file is gone.')) }), `Where ${GUN} is defined could not be read: The file is gone.`],
  ])('refuses, saying why, where %s', async (_case, arrange, refused) => {
    expect(await arrange(kind()).record.definitionOf(RECORD)).toEqual({ refused });
  });
});

describe('what references a record, and its hover (symbols.md, The symbols, Record)', () => {
  it('refuses, rather than list nothing, when mEdit cannot say what references it', async () => {
    const { client, record } = kind();
    client.setQueryFailure('getReferencesInActiveOrCompiledPlugins', localFailure('mEdit is down'));

    expect(await record.referencesTo(RECORD)).toEqual({ refused: `mEdit cannot list what references ${GUN}: mEdit is down` });
  });

  it('has no tooltip for a FormKey no active plugin holds, so its hover is its name', async () => {
    const { client, record } = kind();
    client.setQueryAnswer('getComparison', null);

    expect(await record.tooltipOf(RECORD)).toEqual([]);
  });
});

describe('Go to Symbol in Workspace on a record (symbols.md, The features, story 4)', () => {
  const searching = () => {
    const k = kind();
    k.client.setQueryAnswer('getPlugins', [pluginMetadataFixture({ ...modA, path: '/mods/ModA/A.esp', isCompiledPlugin: true })]);
    k.client.setQueryAnswer('searchRecords', {
      items: [{ formKey: GUN, plugin: modA.name, origin: modA.origin, editorId: 'Gun', loadOrderIndex: 0, isWinner: true, workingTreeState: 'None', hasContainerChildren: false, hasParseFailure: false }],
      total: 1,
    });
    return k;
  };

  it('refuses a pick it cannot open, saying why, so VS Code opens nothing', async () => {
    const { client, record, reporter } = searching();
    client.setQueryAnswer('getCopyDocument', null);
    const [listed] = await record.symbolsFor('Gun', SEARCH);

    await expect(present(listed?.resolve, 'its resolve')()).rejects.toThrow(`Go to Symbol in Workspace cannot open Gun [${GUN}].`);
    expect(reporter.shownFailures.map(({ detail }) => detail)).toEqual([`A.esp (ModA) holds no ${GUN}.`]);
  });

  it('lists a copy at its plugin\'s file, and opens it at its FormKey member in its document once picked', async () => {
    const { record } = searching();
    const [listed] = await record.symbolsFor('Gun', SEARCH);
    const member = GUN_TEXT.indexOf(`"FormKey": "${GUN}"`);

    expect([listed?.location.uri.path, await listed?.resolve?.()]).toMatchObject([
      '/mods/ModA/A.esp', { uri: { path: GUN_FILE }, range: { start: { character: member } } },
    ]);
  });
});

describe('completion at a reference field (symbols.md, The features, story 5)', () => {
  const FIELD = '{ "Armor": "Gu" }';
  const SPAN = { start: FIELD.indexOf('Gu'), end: FIELD.indexOf('Gu') + 2 };
  const document = { uri: Uri.file(GUN_FILE), getText: () => FIELD };
  const copy = (formKey: string, editorId: string | null, plugin = modA) => ({
    formKey, plugin: plugin.name, origin: plugin.origin, editorId, loadOrderIndex: 0, isWinner: true, workingTreeState: 'None' as const,
    hasContainerChildren: false, hasParseFailure: false,
  });
  const completing = (typed: string) => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', [pluginMetadataFixture({ ...modA, path: '/mods/ModA/A.esp' }), pluginMetadataFixture({ name: 'B.esp', origin: 'ModB', path: '/mods/ModB/B.esp' })]);
    client.setQueryAnswer('searchRecords', { items: [copy(GUN, 'Gun'), copy(GUN, 'Gun', { name: 'B.esp', origin: 'ModB' }), copy('000901:A.esp', null)], total: 30 });
    const record = recordLanguage({
      client, reporter: recordingReporter(), names: sourceNames({ referenceTypedAt: () => Promise.resolve({ ...SPAN, typed, types: ['ARMO', 'WEAP'] }) }),
      open: () => Promise.reject(new Error('Completion opens nothing.')),
    });
    return { client, offered: record.completionsAt(document, SPAN.end, COMPLETION) };
  };

  it('offers each record Go to Symbol in Workspace finds once, by EditorID or FormKey, of the types the field allows, for the text typed so far', async () => {
    const { client, offered } = completing('Gu');

    expect(await offered).toEqual({
      ...SPAN, icon: CompletionItemKind.Reference, isIncomplete: true,
      items: [{ label: 'Gun', detail: GUN, insertText: GUN }, { label: '000901:A.esp', detail: '000901:A.esp', insertText: '000901:A.esp' }],
    });
    expect(client.calls.filter(({ method }) => method === 'searchRecords').map(({ args }) => args.slice(0, 2))).toEqual([['Gu', ['ARMO', 'WEAP']]]);
  });

  it('offers nothing before anything is typed, asking mEdit nothing', async () => {
    const { client, offered } = completing('');

    expect([await offered, client.calls]).toEqual([undefined, []]);
  });
});

describe('referenced by on a record anchors its list wherever a plugin holds it (symbols.md, The symbols, Record)', () => {
  const compiled = {
    ...modA, path: '/mods/ModA/A.esp', isLight: false, isMaster: false, isBlueprint: false, masters: [], isImmutable: false, inLoadOrder: false,
    hasMatchingRecords: true, isCompiledPlugin: true, hasParseFailure: false, pluginSourceUnreadable: null,
  };
  const heldByCompiledPlugin = { formKey: GUN, plugin: modA.name, origin: modA.origin, editorId: 'Gun', loadOrderIndex: 0, isWinner: true, workingTreeState: 'None' as const, hasContainerChildren: false, hasParseFailure: false };

  function asking(arrange: (k: ReturnType<typeof kind>) => void = () => undefined) {
    const k = kind();
    k.client.setQueryAnswer('getComparison', null);
    k.client.setQueryAnswer('getPlugins', [compiled]);
    k.client.setQueryAnswer('searchRecords', { items: [heldByCompiledPlugin], total: 1 });
    arrange(k);
    setInput.mockClear();
    return k;
  }
  const shownLocation = () => setInput.mock.calls.at(-1)?.[0].location;

  it('anchors at the record\'s FormKey in its winning copy', async () => {
    const { record } = asking();

    await record.referencedBy(RECORD);

    expect(shownLocation()).toMatchObject({ uri: { path: GUN_FILE }, range: { start: { line: 0, character: GUN_TEXT.indexOf(`"${GUN}"`) } } });
  });

  it('anchors at the top of a compiled plugin\'s copy where no active plugin holds the record', async () => {
    const { record, reporter } = asking((k) => { k.client.setQueryAnswer('getRecordOwner', undefined); });

    await record.referencedBy(RECORD);

    expect([shownLocation(), reporter.reports]).toMatchObject([{ uri: { path: GUN_FILE }, range: { line: 0, character: 0 } }, []]);
  });

  it('is refused, saying why, where the winning copy cannot be read, though a compiled plugin holds the record', async () => {
    const { record, reporter } = asking((k) => { k.client.setQueryFailure('getRecordOwner', localFailure('mEdit is down')); });

    await record.referencedBy(RECORD);

    expect([setInput.mock.calls, reporter.reports.map(({ severity, detail }) => [severity, detail])]).toEqual([[], [['error', 'mEdit is down']]]);
  });

  it('names Referenced By where it cannot search the compiled plugins', async () => {
    const { record, reporter } = asking((k) => {
      k.client.setQueryAnswer('getRecordOwner', undefined);
      k.client.setQueryFailure('getPlugins', localFailure('mEdit is down'));
    });

    await record.referencedBy(RECORD);

    expect(reporter.shownFailures.map(({ message }) => message)).toEqual(['Referenced By cannot list the compiled plugins.']);
  });

  it('is refused, saying why, where no plugin holds the record', async () => {
    const { record, reporter } = asking((k) => {
      k.client.setQueryAnswer('getRecordOwner', undefined);
      k.client.setQueryAnswer('searchRecords', { items: [], total: 0 });
    });

    await record.referencedBy(RECORD);

    expect([setInput.mock.calls, reporter.reports.map(({ severity, detail }) => [severity, detail])]).toEqual([[], [['error', `No active plugin holds ${GUN}.`]]]);
  });
});
