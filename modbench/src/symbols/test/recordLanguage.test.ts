import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { CompletionItemKind, document, host, Location, Range, Uri } from './vscodeHost';
import { symbolsOver } from './symbolsOver';
import { mEditNames, spelledName } from './mEditNames';
import type { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { localFailure } from '../../wire/readFailed';
import { cancellableToken, pluginMetadataFixture } from '../../client/test/fixtures';
import type { CompareResult, PlacedReferences } from '../../client';
import { comparisonOf, type Copy } from '../../test/comparison';
import { DATA_DIRECTORY_ORIGIN } from '../../wire/pluginAddress';
import { copyDocumentUri } from '../../textDocuments/recordDocument';

const GUN = '000801:A.esp';
const modA = { name: 'A.esp', origin: 'ModA' };
const GUN_FILE = '/source/ModA/plugin-source/A.esp/Weapons/Gun.json';
const GUN_TEXT = `{\n  "FormKey": "${GUN}",\n  "EditorID": "Gun"\n}`;
const RECORD = { kind: 'record', formKey: GUN } as const;
const MEMBER = `"FormKey": "${GUN}"`;
const AT_MEMBER = { start: { line: 1, character: 2 }, end: { line: 1, character: 2 + MEMBER.length } };
const AT_FORMKEY = { start: { line: 1, character: 13 }, end: { line: 1, character: 15 + GUN.length } };
const NAMES = mEditNames((text) => [
  ...text.includes(MEMBER) ? [spelledName('Declaration', text, MEMBER, { record: GUN }), spelledName('Record', text, `"${GUN}"`, { record: GUN, fieldPath: 'FormKey', value: GUN })] : [],
]);

function kind({ text = GUN_TEXT, focused, arrange = () => undefined }: { text?: string; focused?: string; arrange?: (client: InMemoryMEditClient) => void } = {}) {
  return symbolsOver({
    names: NAMES, focusedRecord: () => focused,
    arrange: (client) => {
      client.setQueryAnswer('getRecordOwners', [modA]);
      client.setQueryAnswer('getCopyDocument', { kind: 'OwnFile', location: GUN_FILE });
      client.setQueryAnswer('getComparison', null);
      host.holds([document(GUN_FILE, text)]);
      arrange(client);
    },
  });
}

describe('where a record is defined (symbols.md, The symbols, Record)', () => {
  it('is the winning copy\'s file at the record\'s own FormKey member', async () => {
    expect(await kind().symbols.definitionOf(RECORD)).toEqual({ place: { file: GUN_FILE, ...AT_MEMBER } });
  });

  it('is the plugin of a copy that has no plugin source, as the agent reads it', async () => {
    const RENDERED = { kind: 'Rendered', location: 'Gun - 000801_A.esp.json' } as const;
    const { symbols } = kind({ arrange: (client) => {
      client.setQueryAnswer('getCopyDocument', RENDERED);
      host.holds([{ ...document('', GUN_TEXT), uri: copyDocumentUri({ formKey: GUN, plugin: modA }, RENDERED) }]);
    } });

    expect(await symbols.definitionOf(RECORD)).toEqual({ plugin: modA });
  });

  it.each([
    ['the record\'s document states no FormKey member for it', () => kind({ text: '{ "EditorID": "Gun" }' }), `${GUN_FILE} states no ${GUN} member.`],
    ['no active plugin holds it', () => kind({ arrange: (client) => { client.setQueryAnswer('getRecordOwners', []); } }), `No active plugin holds ${GUN}.`],
    ['the winning plugin holds no copy', () => kind({ arrange: (client) => { client.setQueryAnswer('getCopyDocument', null); } }), `A.esp (ModA) holds no ${GUN}.`],
    ['its document fails to open', () => kind({ arrange: () => { host.unopenable.add(GUN_FILE); } }), `Where ${GUN} is defined could not be read: The file is gone.`],
  ])('refuses, saying why, where %s', async (_case, arrange, refused) => {
    expect(await arrange().symbols.definitionOf(RECORD)).toEqual({ refused });
  });
});

describe('what references a record, and its hover (symbols.md, The symbols, Record)', () => {
  it('lists the places mEdit gives, reporting what it left out as unread, and opens no document', async () => {
    const leftOut = `000701:A.esp in B.esp (ModB): its text names ${GUN} nowhere.`;
    const range = { start: { line: 1, character: 2 }, end: { line: 1, character: 18 } };
    const { symbols } = kind({ arrange: (client) => {
      client.setQueryAnswer('getPlacedReferences', { leftOut: [leftOut], copies: [{ formKey: '000700:A.esp', plugin: modA, document: { kind: 'OwnFile', location: GUN_FILE }, ranges: [range] }] });
      host.unopenable.add(GUN_FILE);
    } });

    expect(await symbols.referencesTo(RECORD)).toEqual({ references: [{ file: GUN_FILE, ...range }], leftOut: [leftOut] });
  });

  it('refuses, rather than list nothing, while mEdit cannot answer over every plugin', async () => {
    const { symbols } = kind({ arrange: (client) => { client.setQueryFailure('getPlacedReferences', { failed: 'refused', refusal: 'The record index is still reading.' }); } });

    expect(await symbols.referencesTo(RECORD)).toEqual({ refused: `mEdit cannot list what references ${GUN}: The record index is still reading.` });
  });

  it('has no tooltip for a FormKey no active plugin holds, so its hover is its name', async () => {
    kind();

    expect(await host.hover(GUN_FILE, GUN_TEXT.replace(`"${GUN}"`, `"0008|01:A.esp"`))).toEqual({ text: GUN, spans: `"${GUN}"` });
  });
});

describe('Go to Symbol in Workspace on a record (symbols.md, The features, story 4)', () => {
  const searching = (arrange: (client: InMemoryMEditClient) => void = () => undefined) => kind({ arrange: (client) => {
    client.setQueryAnswer('getPlugins', [pluginMetadataFixture({ ...modA, path: '/mods/ModA/A.esp', isCompiledPlugin: true })]);
    client.setQueryAnswer('searchRecords', {
      items: [{ formKey: GUN, plugin: modA.name, origin: modA.origin, editorId: 'Gun', loadOrderIndex: 0, isWinner: true, workingTreeState: 'None', hasContainerChildren: false, hasParseFailure: false }],
      total: 1,
    });
    arrange(client);
  } });

  it('refuses a pick it cannot open, saying why, so VS Code opens nothing', async () => {
    const { reporter } = searching((client) => { client.setQueryAnswer('getCopyDocument', null); });
    const [listed] = await host.workspaceSymbols('Gun');

    await expect(listed && host.resolveWorkspaceSymbol(listed)).rejects.toThrow(`Go to Symbol in Workspace cannot open Gun [${GUN}].`);
    expect(reporter.shownFailures.map(({ detail }) => detail)).toEqual([`A.esp (ModA) holds no ${GUN}.`]);
  });

  it('lists a copy at its plugin\'s file, and opens it at its FormKey member in its document once picked', async () => {
    searching();
    const [listed] = await host.workspaceSymbols('Gun');
    const at = listed?.location;

    expect([at, (listed && await host.resolveWorkspaceSymbol(listed))?.location]).toEqual([
      new Location(Uri.file('/mods/ModA/A.esp'), new Range(0, 0, 0, 0)), new Location(Uri.file(GUN_FILE), new Range(1, 2, 1, 2 + MEMBER.length)),
    ]);
  });
});

describe('completion at a reference field (symbols.md, The features, story 5)', () => {
  const copy = (formKey: string, editorId: string | null, plugin = modA) => ({
    formKey, plugin: plugin.name, origin: plugin.origin, editorId, loadOrderIndex: 0, isWinner: true, workingTreeState: 'None' as const,
    hasContainerChildren: false, hasParseFailure: false,
  });
  const completing = (typed: string) => {
    const field = `{ "Armor": "${typed}" }`;
    const at = field.indexOf('"', field.indexOf(': ') + 2) + 1;
    const made = symbolsOver({
      names: mEditNames(() => [{ kind: 'Reference', start: at, end: at + typed.length, value: typed, validFormKeyTypes: ['ARMO', 'WEAP'] }]),
      arrange: (client) => {
        client.setQueryAnswer('getPlugins', [pluginMetadataFixture({ ...modA, path: '/mods/ModA/A.esp' }), pluginMetadataFixture({ name: 'B.esp', origin: 'ModB', path: '/mods/ModB/B.esp' })]);
        client.setQueryAnswer('searchRecords', { items: [copy(GUN, 'Gun'), copy(GUN, 'Gun', { name: 'B.esp', origin: 'ModB' }), copy('000901:A.esp', null)], total: 30 });
      },
    });
    const asked = () => made.client.calls.filter(({ method }) => method === 'searchRecords' || method === 'getPlugins');
    return { asked, offered: host.complete(GUN_FILE, `${field.slice(0, at + typed.length)}|${field.slice(at + typed.length)}`) };
  };

  it('offers each record Go to Symbol in Workspace finds once, by EditorID or FormKey, of the types the field allows, for the text typed so far', async () => {
    const { asked, offered } = completing('Gu');

    expect(await offered).toEqual({
      isIncomplete: true,
      items: [
        { label: 'Gun', detail: GUN, kind: CompletionItemKind.Reference, insertText: GUN, replaces: 'Gu' },
        { label: '000901:A.esp', detail: '000901:A.esp', kind: CompletionItemKind.Reference, insertText: '000901:A.esp', replaces: 'Gu' },
      ],
    });
    expect(asked().filter(({ method }) => method === 'searchRecords').map(({ args }) => args.slice(0, 2))).toEqual([['Gu', ['ARMO', 'WEAP']]]);
  });

  it('offers nothing before anything is typed, asking mEdit nothing', async () => {
    const { asked, offered } = completing('');

    expect([await offered, asked()]).toEqual([undefined, []]);
  });
});

describe('referenced by on a record anchors its list wherever a plugin holds it (symbols.md, The symbols, Record)', () => {
  const referencedBy = async (arrange: (client: InMemoryMEditClient) => void = () => undefined) => {
    const made = kind({ focused: GUN, arrange });
    await host.run('modbench.symbol.referencedBy');
    return made;
  };
  const ANCHOR = new Location(Uri.file(GUN_FILE), new Range(AT_FORMKEY.start.line, AT_FORMKEY.start.character, AT_FORMKEY.end.line, AT_FORMKEY.end.character));

  it('anchors at the record\'s FormKey in its winning copy', async () => {
    await referencedBy();

    expect(host.referencesShown.map(({ location }) => location)).toEqual([ANCHOR]);
  });

  it('lists its referrers where several compiled plugins hold the record, anchored at the first one\'s copy', async () => {
    const { client, reporter } = await referencedBy((held) => { held.setQueryAnswer('getRecordOwners', [modA, { name: 'B.esp', origin: 'ModB' }]); });

    expect([host.referencesShown.map(({ location }) => location), client.calls.filter((c) => c.method === 'getCopyDocument').map((c) => c.args), reporter.reports]).toEqual([
      [ANCHOR], [[modA, GUN]], [],
    ]);
  });

  it('is refused, saying why, where mEdit cannot say which plugin owns the record', async () => {
    const { reporter } = await referencedBy((client) => { client.setQueryFailure('getRecordOwners', localFailure('mEdit is down')); });

    expect([host.referencesShown, reporter.reports.map(({ severity, detail }) => [severity, detail])]).toEqual([[], [['error', 'mEdit is down']]]);
  });

  it('is refused, saying why, where no plugin holds the record', async () => {
    const { reporter } = await referencedBy((client) => { client.setQueryAnswer('getRecordOwners', []); });

    expect([host.referencesShown, reporter.reports.map(({ severity, detail }) => [severity, detail])]).toEqual([[], [['error', `No active plugin holds ${GUN}.`]]]);
  });
});

describe('a record\'s hover (symbols.md, The symbols)', () => {
  const AT_GUN = GUN_TEXT.replace(`"${GUN}"`, '"0008|01:A.esp"');
  const comparison = (copies: Copy[] = [{ plugin: 'A.esp', origin: DATA_DIRECTORY_ORIGIN, isWinner: true, editorId: 'Gun' }]): CompareResult => comparisonOf(GUN, copies);
  const hovering = (answer: CompareResult | null) => kind({ arrange: (client) => { client.setQueryAnswer('getComparison', answer); } });

  it.each([
    ['shows EditorID [FormKey], the record type and the winning plugin', comparison(), `\`Gun [${GUN}]\`\n\nWeapon\n\nWinner: A.esp`],
    ['names the winner among several copies, and takes its EditorID', comparison([
      { plugin: 'A.esp', origin: DATA_DIRECTORY_ORIGIN, isWinner: false, editorId: 'Old' },
      { plugin: 'Patch.esp', origin: DATA_DIRECTORY_ORIGIN, isWinner: true, editorId: 'New' },
    ]), `\`New [${GUN}]\`\n\nWeapon\n\nWinner: Patch.esp`],
    ['shows the FormKey alone when the winner has no EditorID', comparison([{ plugin: 'A.esp', origin: DATA_DIRECTORY_ORIGIN, isWinner: true, editorId: null }]), `\`${GUN}\`\n\nWeapon\n\nWinner: A.esp`],
  ])('%s', async (_case, answer, text) => {
    hovering(answer);

    expect((await host.hover(GUN_FILE, AT_GUN))?.text).toBe(text);
  });

  it('asks mEdit with the token of the hover it answers', async () => {
    const { client } = hovering(comparison());
    const { token } = cancellableToken();

    await host.hover(GUN_FILE, AT_GUN, token);

    expect(client.calls.filter(({ method }) => method === 'getComparison')).toEqual([{ method: 'getComparison', args: [GUN, undefined, token] }]);
  });

  it('answers nothing, and writes why to the Output, when mEdit cannot answer', async () => {
    const { reporter } = kind({ arrange: (client) => { client.getComparison = () => Promise.reject(new Error('mEdit is down.')); } });

    expect((await host.hover(GUN_FILE, AT_GUN))?.text).toBe(GUN);
    expect(reporter.shownFailures).toEqual([{ severity: 'error', message: `Hover cannot describe ${GUN}.`, detail: 'mEdit is down.' }]);
  });
});

describe('Find All References on a FormKey (symbols.md, The features, story 2)', () => {
  const STAND = '000700:A.esp';
  const modB = { name: 'B.esp', origin: 'ModB' };
  const on = (line: number, character: number) => ({ start: { line, character }, end: { line, character: character + 16 } });
  const OWN_FILE = { kind: 'OwnFile', location: '/source/ModA/plugin-source/A.esp/Stand.json' } as const;
  const RENDERED = { kind: 'Rendered', location: 'Stand - 000700_A.esp.json' } as const;
  const PLACED: PlacedReferences = {
    copies: [
      { formKey: STAND, plugin: modA, document: OWN_FILE, ranges: [on(2, 11), on(3, 15)] },
      { formKey: STAND, plugin: modB, document: RENDERED, ranges: [on(2, 11)] },
    ],
    leftOut: [],
  };
  const AT_GUN = GUN_TEXT.replace(`"${GUN}"`, '"0008|01:A.esp"');
  const referencing = () => kind({ arrange: (client) => { client.setQueryAnswer('getPlacedReferences', PLACED); } });
  const asked = (client: InMemoryMEditClient) => client.calls.filter(({ method }) => method === 'getPlacedReferences');

  it('asks mEdit with the token of the request it answers', async () => {
    const { client } = referencing();
    const { token } = cancellableToken();

    await host.references(GUN_FILE, AT_GUN, token);

    expect(asked(client)).toEqual([{ method: 'getPlacedReferences', args: [GUN, token] }]);
  });

  it('asks mEdit once, for the record, whatever the number of referrers, and nothing else', async () => {
    const { client } = referencing();
    const before = client.calls.length;

    await host.references(GUN_FILE, AT_GUN);

    expect(client.calls.slice(before)).toEqual([{ method: 'getPlacedReferences', args: [GUN, { isCancellationRequested: false }] }]);
  });

  it('reads each place in plugin source as its place, and one in a copy with no plugin source as the record that holds it, as the agent reads them', async () => {
    const { symbols } = referencing();

    expect(await symbols.referencesTo(RECORD)).toEqual({ references: [
      { file: OWN_FILE.location, start: { line: 2, character: 11 }, end: { line: 2, character: 27 } },
      { file: OWN_FILE.location, start: { line: 3, character: 15 }, end: { line: 3, character: 31 } },
      { formKey: STAND, plugin: modB },
    ], leftOut: [] });
  });

  it('lists each place each copy names the record, at the copy\'s document', async () => {
    referencing();

    expect(await host.references(GUN_FILE, AT_GUN)).toEqual([
      new Location(copyDocumentUri({ formKey: STAND, plugin: modA }, OWN_FILE), new Range(2, 11, 2, 27)),
      new Location(copyDocumentUri({ formKey: STAND, plugin: modA }, OWN_FILE), new Range(3, 15, 3, 31)),
      new Location(copyDocumentUri({ formKey: STAND, plugin: modB }, RENDERED), new Range(2, 11, 2, 27)),
    ]);
  });
});
