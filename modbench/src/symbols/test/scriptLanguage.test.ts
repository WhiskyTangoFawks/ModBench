import { describe, expect, it, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';
import { CompletionItemKind, SymbolKind } from './iconsMock';
import { COMPLETION, SEARCH } from './fakeKinds';

const opened = vi.hoisted(() => new Map<string, string>());
const setInput = vi.hoisted(() => vi.fn());
const Range = vi.hoisted(() => class { readonly args: unknown[]; constructor(...args: unknown[]) { this.args = args; } get start() { return this.args[0]; } get end() { return this.args[1]; } });
vi.mock('vscode', () => ({
  Uri, Range, TreeItem, TreeItemCollapsibleState, SymbolKind, CompletionItemKind,
  Location: class { constructor(readonly uri: unknown, readonly range: unknown) {} },
  extensions: { getExtension: () => ({ activate: () => Promise.resolve({ setInput }) }) },
  workspace: {
    textDocuments: [],
    openTextDocument: (uri: { fsPath: string }) => {
      const text = opened.get(uri.fsPath) ?? '';
      return Promise.resolve({ getText: () => text, positionAt: (offset: number) => ({ line: 0, character: offset }) });
    },
  },
}));

import { scriptLanguage, type ScriptClient } from '../scriptLanguage';
import type { InstanceValue, PapyrusScript } from '../../instanceLoader/instance';
import { sourceNames } from './fakeSourceNames';
import type { SourceNames } from '../sourceNames';
import { recordingReporter } from '../../test/surfacingDoubles';

const QUEST = '000801:Mod.esp';
const SOURCE = '/instance/source/Mod/plugin-source/Mod.esp/Quest.json';
const TEXT = `{ "FormKey": "${QUEST}", "VirtualMachineAdapter": { "Scripts": [ { "Name": "Ns:Quest", "Properties": [ { "Name": "Count" } ] } ] } }`;
const AT_SCRIPT = TEXT.indexOf('Ns:Quest') + 2;
const SPAN = { start: TEXT.indexOf('Ns:Quest'), end: TEXT.indexOf('Ns:Quest') + 'Ns:Quest'.length };
const PATH = 'VirtualMachineAdapter.Scripts[0].Name';

const QUEST_SOURCE = '/instance/mods/Mod/Scripts/Source/User/Ns/Quest.psc';
const SCRIPTS = [
  { name: 'Ns:Quest', source: QUEST_SOURCE, compiled: '/instance/mods/Mod/Scripts/Ns/Quest.pex' },
  { name: 'Other', compiled: '/instance/mods/Mod/Scripts/Other.pex' },
];
const NAMED = [{ file: SOURCE, name: 'Gone' }, { file: SOURCE, name: 'Ns:Quest' }, { file: '/instance/source/Other/Npc.json', name: 'gone' }, { file: '/instance/source/Held/Npc.json', name: 'ns:quest' }];
const NONE = { copies: [], unread: [] };
type Standing = Pick<InstanceValue, 'dataFolderFiles' | 'gameFolder' | 'gameFolderInWorkspace' | 'archiveContents'>;
const JUDGING: Standing = {
  dataFolderFiles: { kind: 'listed', files: new Map() }, gameFolder: { kind: 'found', root: '/game', dataFolder: '/game/Data' },
  gameFolderInWorkspace: true, archiveContents: new Map([['/game/Data/Misc.ba2', { kind: 'read', answer: ['scripts/quest.pex'] }]]),
};

function language(references: Awaited<ReturnType<ScriptClient['getScriptReferences']>> = NONE, scripts: PapyrusScript[] = SCRIPTS, standing: Partial<Standing> = {}, asking: Partial<Pick<SourceNames, 'scriptsNamed' | 'scriptsIn'>> = {}) {
  const client: ScriptClient = {
    getScriptReferences: () => Promise.resolve(references),
    getRecordOwner: () => Promise.resolve(undefined),
    getCopyDocument: (plugin) => Promise.resolve(plugin.origin === 'Gone' ? null : { kind: 'OwnFile' as const, location: SOURCE }),
  };
  const names = sourceNames({
    scriptAt: (file: string, _text: string, offset: number) => Promise.resolve(file === SOURCE && offset === AT_SCRIPT ? { ...SPAN, name: 'Ns:Quest' } : undefined),
    scriptsNamed: () => Promise.resolve(NAMED),
    scriptsIn: (file: string, text: string) => Promise.resolve(file === SOURCE && text === TEXT ? [{ ...SPAN, name: 'Ns:Quest' }, { start: 0, end: 1, name: 'Gone' }] : []),
    ...asking,
    membersIn: (text: string, formKey: string, fieldPaths: readonly string[]) =>
      Promise.resolve(text === TEXT && formKey === QUEST && fieldPaths.includes(PATH) ? [SPAN] : []),
  });
  const instance = { value: { papyrusScripts: scripts, ...JUDGING, ...standing } };
  const reporter = recordingReporter();
  return { language: scriptLanguage({ instance, names, client, reporter }), instance, reporter };
}

const document = (path = SOURCE) => ({ uri: Uri.file(path), getText: () => TEXT });

describe('a Papyrus script\'s name in plugin source (symbols.md, The symbols)', () => {

  it('has no tooltip, since a script has no row', async () => {
    expect(await language().language.tooltipOf({ kind: 'script', name: 'Ns:Quest' })).toEqual([]);
  });

  it('completes to each script', async () => {
    expect(await language().language.completionsAt(document(), AT_SCRIPT, COMPLETION)).toEqual({ ...SPAN, icon: CompletionItemKind.Class, items: [{ label: 'Ns:Quest' }, { label: 'Other' }] });
  });

  it('is found by Go to Symbol at its source, else its compiled script', async () => {
    const { language: symbols } = language();

    expect([...await symbols.symbolsFor('QUEST', SEARCH), ...await symbols.symbolsFor('other', SEARCH)].map(({ name, location }) => [name, location])).toEqual([
      ['Ns:Quest', { uri: Uri.file(QUEST_SOURCE), range: new Range(0, 0, 0, 0) }],
      ['Other', { uri: Uri.file('/instance/mods/Mod/Scripts/Other.pex'), range: new Range(0, 0, 0, 0) }],
    ]);
  });
});

describe('a script a document names that no mod, Overwrite, Data folder file or archive holds (symbols.md, The features, story 8)', () => {
  it('names nothing, saying which script, over its span, and everywhere it looked', async () => {
    expect(await language().language.namesNothingIn(document())).toEqual([{ start: 0, end: 1, name: 'Gone', why: 'No mod, Overwrite, Data folder file or archive holds Gone.' }]);
  });

  const OUTSIDE = 'The game folder /game is outside the workspace, so its archives are not read.';
  const UNREADABLE = '/a.ba2 cannot be read: it is no BA2';
  const NOT_JUDGED = 'The Problems panel does not check the scripts plugin source names.';

  it.each([
    ['the Data folder is not listed', { dataFolderFiles: { kind: 'unresolved' } }, undefined],
    ['the game folder is not found', { gameFolder: { kind: 'notFound', looked: [], setting: 'gameFolder' } }, 'The game folder is not found.'],
    ['the game folder is outside the workspace, so its archives are unread', { gameFolderInWorkspace: false }, OUTSIDE],
    ['an archive has not answered', { archiveContents: new Map([['/a.ba2', { kind: 'unanswered' }]]) }, undefined],
    ['an archive cannot be read', { archiveContents: new Map([['/a.ba2', { kind: 'unreadable', reason: 'it is no BA2' }]]) }, UNREADABLE],
  ] satisfies [string, Partial<Standing>, string | undefined][])('asks mEdit nothing while %s, and says why where the state lasts', async (_case, standing, why) => {
    const asked = { scriptsIn: vi.fn(() => Promise.resolve([])), scriptsNamed: vi.fn(() => Promise.resolve([])) };
    const { language: unjudged, reporter } = language(NONE, SCRIPTS, standing, asked);

    const answers = [await unjudged.namesNothingIn(document()), await unjudged.filesNamingNothing([{ name: 'Mod.esp', origin: 'Mod' }])];

    expect(answers).toEqual(why === undefined ? [undefined, undefined] : [[], []]);
    expect([asked.scriptsIn.mock.calls, asked.scriptsNamed.mock.calls]).toEqual([[], []]);
    expect(reporter.shownFailures).toEqual(why === undefined ? [] : [{ severity: 'warning', message: NOT_JUDGED, detail: why }]);
  });

  it('says it once, again only when the reason changes, and again when judging stopped after it resumed', async () => {
    const { language: judging, instance, reporter } = language(NONE, SCRIPTS, { gameFolderInWorkspace: false });
    const ask = () => judging.namesNothingIn(document());
    await ask();
    await ask();
    instance.value = { ...instance.value, ...JUDGING, archiveContents: new Map([['/a.ba2', { kind: 'unreadable', reason: 'it is no BA2' }]]) };
    await ask();
    instance.value = { ...instance.value, ...JUDGING };
    await ask();
    instance.value = { ...instance.value, gameFolderInWorkspace: false };
    await ask();

    expect(reporter.shownFailures.map(({ detail }) => detail)).toEqual([OUTSIDE, UNREADABLE, OUTSIDE]);
  });

  it('lists each file that holds one, once, whether or not it is open', async () => {
    expect(await language().language.filesNamingNothing()).toEqual([SOURCE, '/instance/source/Other/Npc.json']);
  });

  it('asks of the plugins it is given, and says nothing can be said where mEdit has not answered', async () => {
    const asked = vi.fn<SourceNames['scriptsNamed']>(() => Promise.resolve(undefined));
    const only = [{ name: 'Mod.esp', origin: 'Mod' }];

    expect([await language(NONE, SCRIPTS, {}, { scriptsNamed: asked }).language.filesNamingNothing(only), asked.mock.calls]).toEqual([undefined, [[only]]]);
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

  it('lists where plugin source attaches it in VS Code\'s References view, titled with its name', async () => {
    opened.set(SOURCE, TEXT);
    setInput.mockClear();

    await language({ copies: [copy('Mod')], unread: [] }).language.referencedBy({ kind: 'script', name: 'Ns:Quest' });

    expect(setInput).toHaveBeenCalledWith(expect.objectContaining({ title: 'Referenced By: Ns:Quest', contextValue: 'modbench.scriptReferencedBy' }));
  });
});
