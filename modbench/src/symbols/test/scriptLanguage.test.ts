import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { CompletionItemKind, document, host, Location, Range, Uri, type FakeDocument } from './vscodeHost';
import { instanceHolding, symbolsOver } from './symbolsOver';
import { mEditNames, spelledName } from './mEditNames';
import type { InstanceValue, PapyrusScript } from '../../instanceLoader/instance';
import type { CopyAt } from '../../instanceLoader/fileConflictIndex';
import type { PlacedReferences, PluginFilePaths } from '../../client';
import type { ReadFailed } from '../../wire/readFailed';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { settled as until } from '../../test/eventually';

const QUEST = '000801:Mod.esp';
const SOURCE = '/instance/source/Mod/plugin-source/Mod.esp/Quest.json';
const TEXT = `{ "FormKey": "${QUEST}", "VirtualMachineAdapter": { "Scripts": [ { "Name": "Ns:Quest", "Properties": [ { "Name": "Count" } ] } ] } }`;
const AT_SCRIPT = `${TEXT.slice(0, TEXT.indexOf('Ns:Quest') + 2)}|${TEXT.slice(TEXT.indexOf('Ns:Quest') + 2)}`;
const SPAN = { start: TEXT.indexOf('Ns:Quest'), end: TEXT.indexOf('Ns:Quest') + 'Ns:Quest'.length };

const QUEST_SOURCE = '/instance/mods/Mod/Scripts/Source/User/Ns/Quest.psc';
const QUEST_SOURCE_PATH = 'Scripts/Source/User/Ns/Quest.psc';
const SCRIPTS = [
  { name: 'Ns:Quest', sourceDataPath: QUEST_SOURCE_PATH, compiledDataPath: 'Scripts/Ns/Quest.pex' },
  { name: 'Other', compiledDataPath: 'Scripts/Other.pex' },
];
const OTHER_PEX = '/instance/mods/Mod/Scripts/Other.pex';
const ARCHIVED_PEX = { kind: 'archived', gameRelease: 'Fallout4', archive: '/instance/mods/Mod/Mod - Main.ba2', file: 'Scripts/Packed.pex' } as const;
const ARCHIVE_ONLY = [{ name: 'Packed', compiledDataPath: ARCHIVED_PEX.file }];
const copyOf = (path: string): CopyAt | { none: string } => {
  if (path === QUEST_SOURCE_PATH) return { kind: 'loose', path: QUEST_SOURCE };
  if (path === 'Scripts/Other.pex') return { kind: 'loose', path: OTHER_PEX };
  return path === ARCHIVED_PEX.file ? ARCHIVED_PEX : { none: `Nothing holds ${path}.` };
};
const OTHER_FILE = '/instance/source/Other/plugin-source/Other.esp/Npc.json';
const namedIn = (plugin: string, origin: string, file: string, ...names: string[]): PluginFilePaths =>
  ({ plugin: { name: plugin, origin }, paths: [], unread: [], scripts: names.map((name) => ({ formKey: QUEST, fieldPath: 'Name', sourceRelativePath: `${plugin}/${file}`, name })) });
const NAMED = [namedIn('Mod.esp', 'Mod', 'Quest.json', 'Gone', 'Ns:Quest'), namedIn('Other.esp', 'Other', 'Npc.json', 'gone'), namedIn('Held.esp', 'Held', 'Npc.json', 'ns:quest')];
const NONE = { copies: [], leftOut: [] };
type Standing = Pick<InstanceValue, 'dataFolderFiles' | 'gameFolder' | 'gameFolderInWorkspace' | 'archiveContents'>;
const JUDGING: Standing = {
  dataFolderFiles: { kind: 'listed', files: new Map() }, gameFolder: { kind: 'found', root: '/game', dataFolder: '/game/Data' },
  gameFolderInWorkspace: true, archiveContents: new Map([['/game/Data/Misc.ba2', { kind: 'read', answer: ['scripts/quest.pex'] }]]),
};
const NAMES = mEditNames((text) => (text === TEXT ? [spelledName('Script', TEXT, 'Ns:Quest'), { kind: 'Script', start: 0, end: 1, value: 'Gone' }] : []));

function language(references: PlacedReferences | ReadFailed = NONE, scripts: PapyrusScript[] = SCRIPTS, standing: Partial<Standing> = {}, named: PluginFilePaths[] = NAMED, held: FakeDocument[] = []) {
  const reveal = vi.fn(() => Promise.resolve());
  const instance = instanceHolding(instanceValueFixture({ papyrusScripts: scripts, ...JUDGING, ...standing }));
  const made = symbolsOver({
    instance, names: NAMES, fileCopies: { copyOf, reveal }, sourceFiles: (origin) => ({ file: (relativePath) => `/instance/source/${origin}/plugin-source/${relativePath}` }),
    arrange: (client) => { client.setQueryAnswer('getPlacedScriptReferences', references); client.setQueryAnswer('getPluginFilePaths', named); host.holds(held); },
  });
  return { ...made, instance, reveal };
}

const NAMES_NOTHING = 'modbench-names';
const goneOn = (file: string, at = { start: 0, end: 1 }) => [file, [{ message: 'Gone names nothing. No mod, Overwrite, Data folder file or archive holds Gone.', start: { line: 0, character: at.start }, end: { line: 0, character: at.end } }]];

describe('a Papyrus script\'s name in plugin source (symbols.md, The symbols)', () => {
  it('has no tooltip, since a script has no row', async () => {
    language();

    expect(await host.hover(SOURCE, AT_SCRIPT)).toEqual({ text: 'Ns:Quest', spans: 'Ns:Quest' });
  });

  it('completes to each script', async () => {
    language();

    expect(await host.complete(SOURCE, AT_SCRIPT)).toEqual({ isIncomplete: false, items: ['Ns:Quest', 'Other'].map((label) => ({ label, detail: undefined, kind: CompletionItemKind.Class, insertText: undefined, replaces: 'Ns:Quest' })) });
  });

  it('is found by Go to Symbol at its source, else its compiled script', async () => {
    language();

    expect([...await host.workspaceSymbols('QUEST'), ...await host.workspaceSymbols('other')].map(({ name, location }) => [name, location])).toEqual([
      ['Ns:Quest', new Location(Uri.file(QUEST_SOURCE), new Range(0, 0, 0, 0))],
      ['Other', new Location(Uri.file(OTHER_PEX), new Range(0, 0, 0, 0))],
    ]);
  });

  it('is found by Go to Symbol when only an archive holds its compiled script, at that archive', async () => {
    const { reveal } = language(NONE, ARCHIVE_ONLY);

    const [found] = await host.workspaceSymbols('packed');
    if (found) await host.resolveWorkspaceSymbol(found);

    expect([found?.name, found?.location, reveal.mock.calls]).toEqual(['Packed', new Location(Uri.file(ARCHIVED_PEX.archive), new Range(0, 0, 0, 0)), [[ARCHIVED_PEX]]]);
  });
});

describe('a script a document names that no mod, Overwrite, Data folder file or archive holds (symbols.md, The features, story 8)', () => {
  it('names nothing, saying which script, over its span, and everywhere it looked', async () => {
    language(NONE, SCRIPTS, {}, [], [document(SOURCE, TEXT)]);

    await until(() => { expect([...host.problems(NAMES_NOTHING)]).toEqual([goneOn(SOURCE)]); });
  });

  const OUTSIDE = 'The game folder /game is outside the workspace, so its archives are not read.';
  const UNREADABLE = '/a.ba2 cannot be read: it is no BA2';
  const NOT_JUDGED = 'The Problems panel does not check the scripts plugin source names.';

  it.each([
    ['the game folder is not found', { gameFolder: { kind: 'notFound', looked: [], setting: 'gameFolder' } }, 'The game folder is not found.'],
    ['the game folder is outside the workspace, so its archives are unread', { gameFolderInWorkspace: false }, OUTSIDE],
    ['an archive cannot be read', { archiveContents: new Map([['/a.ba2', { kind: 'unreadable', reason: 'it is no BA2' }]]) }, UNREADABLE],
  ] satisfies [string, Partial<Standing>, string][])('asks mEdit nothing while %s, and says why where the state lasts', async (_case, standing, why) => {
    const { client, reporter } = language(NONE, SCRIPTS, standing);

    await until(() => { expect(reporter.shownFailures).toEqual([{ severity: 'warning', message: NOT_JUDGED, detail: why }]); });
    expect([client.calls.filter(({ method }) => method === 'getPluginFilePaths'), [...host.problems(NAMES_NOTHING)]]).toEqual([[], []]);
  });

  it.each([
    ['the Data folder is not listed', { dataFolderFiles: { kind: 'unresolved' } }],
    ['an archive has not answered', { archiveContents: new Map([['/a.ba2', { kind: 'unanswered' }]]) }],
  ] satisfies [string, Partial<Standing>][])('says nothing while %s, and judges once it is', async (_case, standing) => {
    const { instance, reporter } = language(NONE, SCRIPTS, standing, [], [document(SOURCE, TEXT)]);

    instance.land({ ...instance.value, ...JUDGING });
    host.change(document(SOURCE, TEXT));

    await until(() => { expect([...host.problems(NAMES_NOTHING)]).toEqual([goneOn(SOURCE)]); });
    expect(reporter.shownFailures).toEqual([]);
  });

  it('says it once, again only when the reason changes, and again when judging stopped after it resumed', async () => {
    const { instance, reporter } = language(NONE, SCRIPTS, { gameFolderInWorkspace: false });
    const land = async (standing: Partial<Standing>, told: number) => {
      instance.land({ ...instance.value, ...standing });
      host.change(document(SOURCE, TEXT));
      await until(() => { expect(reporter.shownFailures).toHaveLength(told); });
    };
    await until(() => { expect(reporter.shownFailures).toHaveLength(1); });

    await land({ ...JUDGING, archiveContents: new Map([['/a.ba2', { kind: 'unreadable', reason: 'it is no BA2' }]]) }, 2);
    await land(JUDGING, 2);
    await land({ gameFolderInWorkspace: false }, 3);

    expect(reporter.shownFailures.map(({ detail }) => detail)).toEqual([OUTSIDE, UNREADABLE, OUTSIDE]);
  });

  it('lists each file that holds one, once, whether or not it is open', async () => {
    const { files } = language();
    files.set(SOURCE, TEXT);
    files.set(OTHER_FILE, TEXT);

    await until(() => { expect([...host.problems(NAMES_NOTHING)].sort()).toEqual([goneOn(SOURCE), goneOn(OTHER_FILE)]); });
  });

  it('asks of the plugins a change names, and keeps what it shows where mEdit has not answered', async () => {
    const { client, files } = language(NONE, SCRIPTS, {}, [NAMED[0] ?? namedIn('Mod.esp', 'Mod', 'Quest.json')]);
    files.set(SOURCE, TEXT);
    await until(() => { expect([...host.problems(NAMES_NOTHING).keys()]).toEqual([SOURCE]); });
    client.setQueryAnswer('getPluginFilePaths', { failed: 'refused', refusal: 'the record index is not ready' });

    client.change([{ plugin: { name: 'Mod.esp', origin: 'Mod' } }]);

    await until(() => { expect(client.calls.filter(({ method }) => method === 'getPluginFilePaths').at(-1)?.args[0]).toEqual({ name: 'Mod.esp', origin: 'Mod' }); });
    expect([...host.problems(NAMES_NOTHING).keys()]).toEqual([SOURCE]);
  });
});

describe('where a Papyrus script is defined, and the records that attach it', () => {
  const copy = (origin: string) => ({
    formKey: QUEST, plugin: { name: 'Mod.esp', origin }, document: { kind: 'OwnFile' as const, location: SOURCE },
    ranges: [{ start: { line: 0, character: SPAN.start }, end: { line: 0, character: SPAN.end } }],
  });

  it.each([
    ['at its source', 'ns:quest', SCRIPTS, { file: QUEST_SOURCE }],
    ['at its compiled script when it has no source', 'Other', SCRIPTS, { file: OTHER_PEX }],
    ['at its archived compiled script when only an archive holds it', 'Packed', ARCHIVE_ONLY, { archived: { archive: ARCHIVED_PEX.archive, file: ARCHIVED_PEX.file } }],
    ['at its compiled script when its source is a copy the game gets nowhere', 'Outside', [{ name: 'Outside', sourceDataPath: 'Scripts/Source/Base/Outside.psc', compiledDataPath: 'Scripts/Other.pex' }], { file: OTHER_PEX }],
    ['nowhere when neither its source nor its compiled script is a copy the game gets, refusing', 'Outside', [{ name: 'Outside', sourceDataPath: 'Scripts/Source/Base/Outside.psc', compiledDataPath: 'Scripts/Outside.pex' }], { refused: 'Nothing holds Scripts/Outside.pex.' }],
    ['nowhere when no copy of its compiled script is held, refusing', 'Packed', [{ name: 'Packed', compiledDataPath: 'Scripts/Gone.pex' }], { refused: 'Nothing holds Scripts/Gone.pex.' }],
    ['nowhere when no mod holds it, refusing', 'Ns:Quest', [], { refused: 'No mod, Overwrite or the Data folder holds a source or a compiled script of Ns:Quest.' }],
  ])('defines a script %s', async (_case, name, scripts, expected) => {
    expect(await language(NONE, scripts).symbols.definitionOf({ kind: 'script', name })).toEqual(expected);
  });

  it('lists each member of a record mEdit says attaches it, and why it left out each copy it could not read', async () => {
    const { symbols } = language({ copies: [copy('Mod')], leftOut: ['000802:Mod.esp in Mod.esp (Mod): mEdit has no schema for its record type xxxx'] });

    expect(await symbols.referencesTo({ kind: 'script', name: 'Ns:Quest' })).toEqual({
      references: [{ file: SOURCE, start: { line: 0, character: SPAN.start }, end: { line: 0, character: SPAN.end } }],
      leftOut: ['000802:Mod.esp in Mod.esp (Mod): mEdit has no schema for its record type xxxx'],
    });
  });

  it('says why it could not read what mEdit reads', async () => {
    const { symbols } = language({ failed: 'refused', refusal: 'the record index is not ready' });

    expect(await symbols.referencesTo({ kind: 'script', name: 'Ns:Quest' })).toEqual({ references: [], leftOut: ['the plugins mEdit reads: the record index is not ready'] });
  });

  it('lists where plugin source attaches it in VS Code\'s References view, titled with its name', async () => {
    language({ copies: [copy('Mod')], leftOut: [] }, SCRIPTS, {}, NAMED, [document(SOURCE, TEXT)]);

    const running = host.run('modbench.symbol.referencedBy');
    const [pick] = host.quickPicks;
    pick?.type('Ns:Quest');
    await until(() => { expect(pick?.qp.items.map(({ label }) => label)).toEqual(['Ns:Quest']); });
    pick?.accept(pick.qp.items[0] ?? { label: '' });
    await running;

    expect(host.referencesShown).toEqual([expect.objectContaining({ title: 'Referenced By: Ns:Quest', contextValue: 'modbench.scriptReferencedBy' })]);
  });
});
