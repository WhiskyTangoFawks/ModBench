import { describe, expect, it, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';

const opened = vi.hoisted(() => new Map<string, string>());
const Range = vi.hoisted(() => class { readonly args: unknown[]; constructor(...args: unknown[]) { this.args = args; } });
vi.mock('vscode', () => ({
  Uri, Range, TreeItem, TreeItemCollapsibleState,
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
  it('is a hover that says its name, over the name between its quotes', async () => {
    expect(await language().language.hoverAt(document(), AT_SCRIPT)).toEqual({ ...SPAN, lines: ['Ns:Quest'] });
  });

  it.each([
    ['a property\'s name', document(), AT_PROPERTY],
    ['a record\'s FormKey', document(), TEXT.indexOf(QUEST) + 2],
    ['a file that is no plugin source', document('/instance/notes.json'), AT_SCRIPT],
  ])('is not %s', async (_case, at, offset) => {
    expect(await language().language.hoverAt(at, offset)).toBeUndefined();
  });

  it('goes to its source, else its compiled script, as the instance holds them', async () => {
    expect(await language().language.definitionAt(document(), AT_SCRIPT)).toEqual({ ...SPAN, file: QUEST_SOURCE });
  });

  it('says why Go to Definition cannot go to a script no mod holds', async () => {
    const { language: unheld, reporter } = language(NONE, []);

    expect(await unheld.definitionAt(document(), AT_SCRIPT)).toEqual({ ...SPAN, file: undefined });
    expect(reporter.shownFailures).toEqual([{
      severity: 'warning', message: 'Go to Definition cannot go to Ns:Quest.', detail: 'No mod, Overwrite or the Data folder holds a source or a compiled script of Ns:Quest.',
    }]);
  });

  it('completes to each script', async () => {
    expect(await language().language.completionsAt(document(), AT_SCRIPT)).toEqual({ ...SPAN, items: ['Ns:Quest', 'Other'] });
  });

  it('is found by Go to Symbol at its source, else its compiled script', () => {
    const { language: symbols } = language();

    expect([...symbols.symbolsFor('QUEST'), ...symbols.symbolsFor('other')].map(({ name, location }) => [name, location])).toEqual([
      ['Ns:Quest', { uri: Uri.file(QUEST_SOURCE), range: new Range(0, 0, 0, 0) }],
      ['Other', { uri: Uri.file('/instance/mods/Mod/Scripts/Other.pex'), range: new Range(0, 0, 0, 0) }],
    ]);
  });
});

describe('Find All References on a Papyrus script', () => {
  const copy = (origin: string) => ({ formKey: QUEST, plugin: { name: 'Mod.esp', origin }, inPluginSource: true, fieldPaths: [PATH] });

  it('lists each member of a record mEdit says attaches it, and says in the Output why it left out a copy', async () => {
    opened.set(SOURCE, TEXT);
    const { language: answering, reporter } = language({ copies: [copy('Mod'), copy('Gone')], unread: ['000802:Mod.esp in Mod.esp (Mod): mEdit has no schema for its record type xxxx'] });

    const found = await answering.referencesAt(document(), AT_SCRIPT);

    expect(found?.map(({ uri, range }) => [uri, range])).toEqual([[Uri.file(SOURCE), new Range({ line: 0, character: SPAN.start }, { line: 0, character: SPAN.end })]]);
    expect(reporter.shownFailures.map(({ detail }) => detail)).toEqual([
      '000802:Mod.esp in Mod.esp (Mod): mEdit has no schema for its record type xxxx', 'Mod.esp (Gone) holds no 000801:Mod.esp.',
    ]);
  });

  it('says in the Output why it could not read what mEdit reads', async () => {
    const { language: failing, reporter } = language({ failed: 'refused', refusal: 'the record index is not ready' });

    expect(await failing.referencesAt(document(), AT_SCRIPT)).toEqual([]);
    expect(reporter.shownFailures.map(({ detail }) => detail)).toEqual(['the plugins mEdit reads: the record index is not ready']);
  });
});
