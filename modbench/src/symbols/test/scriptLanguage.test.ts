import { describe, expect, it, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';
import { CompletionItemKind, SymbolKind } from './iconsMock';

const opened = vi.hoisted(() => new Map<string, string>());
const Range = vi.hoisted(() => class { readonly args: unknown[]; constructor(...args: unknown[]) { this.args = args; } get start() { return this.args[0]; } get end() { return this.args[1]; } });
vi.mock('vscode', () => ({
  Uri, Range, TreeItem, TreeItemCollapsibleState, SymbolKind, CompletionItemKind,
  Location: class { constructor(readonly uri: unknown, readonly range: unknown) {} },
  workspace: {
    textDocuments: [],
    openTextDocument: (uri: { fsPath: string }) => {
      const text = opened.get(uri.fsPath) ?? '';
      return Promise.resolve({ getText: () => text, positionAt: (offset: number) => ({ line: 0, character: offset }) });
    },
  },
}));

import { scriptLanguage, type ScriptClient } from '../scriptLanguage';
import type { CompareResult } from '../../client';
import { comparisonOf, fieldOf } from '../../test/comparison';
import { recordingReporter } from '../../test/surfacingDoubles';

const QUEST = '000801:Mod.esp';
const SOURCE = '/instance/source/Mod/plugin-source/Mod.esp/Quest.json';
const TEXT = `{ "FormKey": "${QUEST}", "VirtualMachineAdapter": { "Scripts": [ { "Name": "Ns:Quest", "Properties": [ { "Name": "Count" } ] } ] } }`;
const AT_SCRIPT = TEXT.indexOf('Ns:Quest') + 2;
const AT_PROPERTY = TEXT.indexOf('Count') + 2;
const SPAN = { start: TEXT.indexOf('Ns:Quest'), end: TEXT.indexOf('Ns:Quest') + 'Ns:Quest'.length };
const PATH = 'VirtualMachineAdapter.Scripts[0].Name';

const adapter = fieldOf({
  name: 'VirtualMachineAdapter', type: 'struct', fields: [fieldOf({
    name: 'Scripts', type: 'array', isArray: true, elementType: fieldOf({
      name: 'Script', type: 'struct', fields: [
        fieldOf({ name: 'Name', type: 'string', isScriptName: true }).metadata,
        fieldOf({ name: 'Properties', type: 'array', isArray: true, elementType: fieldOf({ name: 'Property', type: 'struct', fields: [fieldOf({ name: 'Name', type: 'string' }).metadata] }).metadata }).metadata,
      ],
    }).metadata,
  }).metadata],
});

const QUEST_SOURCE = '/instance/mods/Mod/Scripts/Source/User/Ns/Quest.psc';
const SCRIPTS = [
  { name: 'Ns:Quest', source: QUEST_SOURCE, compiled: '/instance/mods/Mod/Scripts/Ns/Quest.pex' },
  { name: 'Other', compiled: '/instance/mods/Mod/Scripts/Other.pex' },
];
const NONE = { copies: [], unread: [] };

function language(references: Awaited<ReturnType<ScriptClient['getScriptReferences']>> = NONE, scripts: { name: string; source?: string; compiled?: string }[] = SCRIPTS) {
  const reporter = recordingReporter();
  const client: ScriptClient = {
    getComparison: () => Promise.resolve<CompareResult | null>(comparisonOf(QUEST, [{ plugin: 'Mod.esp', isWinner: true, fields: [adapter] }])),
    getScriptReferences: () => Promise.resolve(references),
    getRecordOwner: () => Promise.resolve(undefined),
    getCopyDocument: (plugin) => Promise.resolve(plugin.origin === 'Gone' ? null : { kind: 'OwnFile' as const, location: SOURCE }),
  };
  return { language: scriptLanguage({ instance: { value: { papyrusScripts: scripts } }, reporter, client }), reporter };
}

const document = (path = SOURCE) => ({ uri: Uri.file(path), getText: () => TEXT });

describe('a Papyrus script\'s name in plugin source (symbols.md, The symbols)', () => {
  it('spans its name between its quotes', async () => {
    expect(await language().language.nameAt(document(), AT_SCRIPT)).toEqual({ ...SPAN, spelled: 'Ns:Quest', symbol: { kind: 'script', name: 'Ns:Quest' } });
  });

  it.each([
    ['a property\'s name', document(), AT_PROPERTY],
    ['a record\'s FormKey', document(), TEXT.indexOf(QUEST) + 2],
    ['a file that is no plugin source', document('/instance/notes.json'), AT_SCRIPT],
  ])('is not %s', async (_case, at, offset) => {
    expect(await language().language.nameAt(at, offset)).toBeUndefined();
  });

  it('is a hover that says its name', async () => {
    expect(await language().language.hoverOf({ ...SPAN, spelled: 'Ns:Quest', symbol: { kind: 'script', name: 'Ns:Quest' } })).toEqual(['Ns:Quest']);
  });

  it('completes to each script', async () => {
    expect(await language().language.completionsAt(document(), AT_SCRIPT)).toEqual({ ...SPAN, icon: CompletionItemKind.Class, items: [{ label: 'Ns:Quest' }, { label: 'Other' }] });
  });

  it('is found by Go to Symbol at its source, else its compiled script', async () => {
    const { language: symbols } = language();

    expect([...await symbols.symbolsFor('QUEST'), ...await symbols.symbolsFor('other')].map(({ name, location }) => [name, location])).toEqual([
      ['Ns:Quest', { uri: Uri.file(QUEST_SOURCE), range: new Range(0, 0, 0, 0) }],
      ['Other', { uri: Uri.file('/instance/mods/Mod/Scripts/Other.pex'), range: new Range(0, 0, 0, 0) }],
    ]);
  });
});

describe('where a Papyrus script is defined, and the records that attach it', () => {
  const copy = (origin: string) => ({ formKey: QUEST, plugin: { name: 'Mod.esp', origin }, inPluginSource: true, fieldPaths: [PATH] });

  it.each([
    ['at its source', 'ns:quest', SCRIPTS, { file: QUEST_SOURCE }],
    ['at its compiled script when it has no source', 'Other', SCRIPTS, { file: '/instance/mods/Mod/Scripts/Other.pex' }],
    ['nowhere when no mod holds it, refusing', 'Ns:Quest', [], { refused: 'No mod, Overwrite or the Data folder holds a source or a compiled script of Ns:Quest.' }],
  ])('defines a script %s', async (_case, name, scripts, expected) => {
    expect(await language(NONE, scripts).language.definitionOf({ kind: 'script', name })).toEqual(expected);
  });

  it('lists each member of a record mEdit says attaches it, and why it left out each copy it could not read', async () => {
    opened.set(SOURCE, TEXT);
    const { language: answering } = language({ copies: [copy('Mod'), copy('Gone')], unread: ['000802:Mod.esp in Mod.esp (Mod): mEdit has no schema for its record type xxxx'] });

    const found = await answering.referencesTo({ kind: 'script', name: 'Ns:Quest' });

    expect('locations' in found && [found.locations.map(({ uri, range }) => [uri, range]), found.unread]).toEqual([
      [[Uri.file(SOURCE), new Range({ line: 0, character: SPAN.start }, { line: 0, character: SPAN.end })]],
      ['000802:Mod.esp in Mod.esp (Mod): mEdit has no schema for its record type xxxx', 'Mod.esp (Gone) holds no 000801:Mod.esp.'],
    ]);
  });

  it('says why it could not read what mEdit reads', async () => {
    const { language: failing } = language({ failed: 'refused', refusal: 'the record index is not ready' });

    expect(await failing.referencesTo({ kind: 'script', name: 'Ns:Quest' })).toEqual({ locations: [], unread: ['the plugins mEdit reads: the record index is not ready'] });
  });
});

