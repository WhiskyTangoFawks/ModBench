import type { FilePathsAsked } from '../scriptsNamed';
import { describe, expect, it, vi } from 'vitest';
import { sourceNames } from '../sourceNames';
import type { DocumentName, MEditClient } from '../../client';
import { recordingReporter } from '../../test/surfacingDoubles';
import { cancellableToken } from '../../client/test/fixtures';
import { localFailure, type ReadFailed } from '../../wire/readFailed';

const NPC = '000801:Mod.esp';
const FILE = '/instance/source/Mod/plugin-source/Mod.esp/Npc.json';
const TEXT = '{ "FormKey": "000801:Mod.esp", "Armor": "Gu" }';

const named = (kind: DocumentName['kind'], start: number, end: number, value: string, over: Partial<DocumentName> = {}): DocumentName =>
  ({ kind, start, end, value, record: NPC, fieldPath: 'Armor', ...over });

const OWN = named('Record', 13, 29, NPC, { fieldPath: 'FormKey' });

function names(answer: DocumentName[] | ReadFailed) {
  const reporter = recordingReporter();
  const client = { getPluginSourceNames: vi.fn<MEditClient['getPluginSourceNames']>(() => Promise.resolve(answer)) };
  return { owner: sourceNames({ names: client, paths: { getPluginFilePaths: () => Promise.resolve([]) }, sourceFiles: () => undefined, reporter }), client, reporter };
}

describe('the names at a place in plugin source, as mEdit answers them (target-architecture.md)', () => {
  it('answers each kind the name of that kind at a place, asking with its file', async () => {
    const { owner, client } = names([named('Script', 40, 42, 'Gu')]);

    const answers = [await owner.recordAt(FILE, TEXT, 41), await owner.scriptAt(FILE, TEXT, 41)];

    expect([answers, client.getPluginSourceNames.mock.calls[0]]).toEqual([[undefined, { start: 40, end: 42, name: 'Gu' }], [TEXT, FILE, 41, undefined]]);
  });

  it('asks mEdit with the token of the request it answers', async () => {
    const { owner, client } = names([named('Script', 40, 42, 'Gu')]);
    const { token } = cancellableToken();

    await owner.scriptAt(FILE, TEXT, 41, token);

    expect(client.getPluginSourceNames.mock.calls).toEqual([[TEXT, FILE, 41, token]]);
  });

  it('tells the Output once of a place mEdit cannot answer for, however many kinds ask of it', async () => {
    const { owner, reporter } = names(localFailure('mEdit is down'));

    await owner.recordAt(FILE, TEXT, 20);
    await owner.scriptAt(FILE, TEXT, 20);

    expect(reporter.shownFailures).toHaveLength(1);
  });

  it.each([
    ['the file, by its path in the Data folder', named('File', 1, 4, 'a.dds', { dataPath: 'Textures/a.dds' }), { start: 1, end: 4, given: 'a.dds', path: 'Textures/a.dds' }],
    ['no file, saying why', named('File', 1, 4, 'Data/a.dds', { refusal: 'It is no path a texture holds.' }), { start: 1, end: 4, given: 'Data/a.dds', refused: 'It is no path a texture holds.' }],
    ['nothing where the path is empty', named('File', 1, 1, ''), undefined],
  ])('names, at a path, %s', async (_case, name, expected) => {
    expect(await names([name]).owner.fileAt(FILE, TEXT, 2)).toEqual(expected);
  });

  it('answers, at a path, its span, the text typed in it before the cursor, and its field\'s asset type', async () => {
    const assetType = { folder: 'Textures', extensions: ['.dds'] };

    expect(await names([named('File', 41, 43, 'Gu', { assetType })]).owner.pathTypedAt(FILE, TEXT, 42)).toEqual({ start: 41, end: 43, typed: 'G', assetType });
  });

  it('names nothing where mEdit cannot answer, and the Output says why', async () => {
    const { owner, reporter } = names(localFailure('mEdit is down'));

    expect(await owner.recordAt(FILE, TEXT, 20)).toBeUndefined();
    expect(reporter.shownFailures).toEqual([{ severity: 'error', message: 'Cannot tell what plugin source names here.', detail: 'mEdit is down' }]);
  });
});

describe('every script a document names, with its span', () => {
  it('asks for the whole document and answers each script in it', async () => {
    const { owner, client } = names([named('Record', 13, 29, NPC), named('Script', 40, 42, 'Gu'), named('Script', 50, 53, 'Other')]);

    expect(await owner.scriptsIn(FILE, TEXT)).toEqual([{ start: 40, end: 42, name: 'Gu' }, { start: 50, end: 53, name: 'Other' }]);
    expect(client.getPluginSourceNames.mock.calls).toEqual([[TEXT, FILE]]);
  });

  it('fails where mEdit cannot answer, for its caller to say', async () => {
    await expect(names(localFailure('mEdit is down')).owner.scriptsIn(FILE, TEXT)).rejects.toThrow('mEdit is down');
  });
});

describe('every script the plugin source of the compiled plugins names', () => {
  type Answer = Awaited<ReturnType<MEditClient['getPluginFilePaths']>>;
  const ORIGIN = 'ModA';
  const plugin = { name: 'Mod.esp', origin: ORIGIN };
  const beside = { name: 'Beside.esp', origin: ORIGIN };
  const FILE_OF = (relative: string) => `/instance/source/ModA/${relative}`;
  const attached = (name: string, sourceRelativePath: string) => ({ formKey: NPC, fieldPath: 'VirtualMachineAdapter.Scripts[0].Name', sourceRelativePath, name });
  const holding = (who: typeof plugin, name: string, over: Partial<Extract<Answer, unknown[]>[number]> = {}) =>
    ({ plugin: who, paths: [], scripts: [attached(name, `${who.name}/Npc.json`)], unread: [], ...over });
  const owning = (answer: (asked?: Parameters<MEditClient['getPluginFilePaths']>[0]) => Answer) => {
    const files = (origin: string) => (origin === ORIGIN ? { file: FILE_OF } : undefined);
    const paths = { getPluginFilePaths: vi.fn<FilePathsAsked['getPluginFilePaths']>((asked) => Promise.resolve(answer(asked))) };
    const reporter = recordingReporter();
    return { owner: sourceNames({ names: { getPluginSourceNames: vi.fn() }, paths, sourceFiles: files, reporter }), paths, reporter };
  };

  it('asks once for every plugin and answers each script with the file that holds it, the plugins of no mod left out', async () => {
    const { owner, paths } = owning(() => [holding(plugin, 'Gone'), holding({ name: 'Other.esp', origin: 'Overwrite' }, 'Elsewhere')]);

    expect(await owner.scriptsNamed()).toEqual([{ file: FILE_OF('Mod.esp/Npc.json'), name: 'Gone' }]);
    expect(paths.getPluginFilePaths.mock.calls).toEqual([[]]);
  });

  it('asks of the records a change names, and places an answer given again as it was only once', async () => {
    const answer = [holding(plugin, 'Gone')];
    const { owner, paths } = owning(() => answer);
    const placed = vi.fn(FILE_OF);
    const placing = sourceNames({ names: { getPluginSourceNames: vi.fn() }, paths, sourceFiles: () => ({ file: placed }), reporter: recordingReporter() });

    await placing.scriptsNamed([{ plugin, keys: ['000800:Mod.esp'] }]);
    await placing.scriptsNamed([{ plugin }]);

    expect([paths.getPluginFilePaths.mock.calls, placed.mock.calls.length]).toEqual([[[plugin, ['000800:Mod.esp']], [plugin, undefined]], 1]);
    expect(await owner.scriptsNamed()).toHaveLength(1);
  });

  it('answers the same list while every answer is the one it had', async () => {
    const answer = [holding(plugin, 'Gone')];
    const { owner } = owning(() => answer);

    const first = await owner.scriptsNamed();
    const again = await owner.scriptsNamed([{ plugin }]);

    expect(again).toBe(first);
  });

  it('answers another list when an answer is another', async () => {
    let answer = [holding(plugin, 'Gone')];
    const { owner } = owning(() => answer);
    const first = await owner.scriptsNamed();

    answer = [holding(plugin, 'Gone')];

    expect(await owner.scriptsNamed([{ plugin }])).not.toBe(first);
  });

  it('says nothing is answered while the record index cannot answer yet', async () => {
    expect(await owning(() => ({ failed: 'refused', refusal: 'not ready' })).owner.scriptsNamed()).toBeUndefined();
  });

  it('fails where mEdit cannot answer, for its caller to say', async () => {
    await expect(owning(() => localFailure('mEdit is down')).owner.scriptsNamed()).rejects.toThrow('mEdit is down');
  });

  it('asks of the plugins named alone, answers every plugin\'s scripts, and asks of none for an empty list', async () => {
    const { owner, paths } = owning((asked) => [holding(asked ?? plugin, `Of${asked?.name ?? 'All'}`)]);
    await owner.scriptsNamed([{ plugin }]);
    await owner.scriptsNamed([{ plugin: beside }]);

    expect(await owner.scriptsNamed([])).toEqual([
      { file: FILE_OF('Mod.esp/Npc.json'), name: 'OfMod.esp' }, { file: FILE_OF('Beside.esp/Npc.json'), name: 'OfBeside.esp' },
    ]);
    expect(paths.getPluginFilePaths.mock.calls).toEqual([[plugin, undefined], [beside, undefined]]);
  });

  it('drops a plugin that left the load order, and keeps what a plugin whose answer failed last held, saying why once', async () => {
    let answer: Answer = [holding(plugin, 'First'), holding(beside, 'Second')];
    const { owner, reporter } = owning(() => answer);
    await owner.scriptsNamed();
    answer = [holding(plugin, 'Changed', { failure: 'its source is unreadable' })];

    const kept = [await owner.scriptsNamed(), await owner.scriptsNamed()];

    expect(kept).toEqual([[{ file: FILE_OF('Mod.esp/Npc.json'), name: 'First' }], [{ file: FILE_OF('Mod.esp/Npc.json'), name: 'First' }]]);
    expect(reporter.shownFailures).toEqual([{ severity: 'warning', message: 'The Problems panel does not check every script plugin source names.', detail: 'Mod.esp (ModA): its source is unreadable' }]);
  });

  it('says the copies it could not read, and keeps the scripts that read', async () => {
    const { owner, reporter } = owning(() => [holding(plugin, 'Read', { unread: ['000801:Mod.esp: no schema'] })]);

    expect(await owner.scriptsNamed()).toEqual([{ file: FILE_OF('Mod.esp/Npc.json'), name: 'Read' }]);
    expect(reporter.shownFailures.map(({ detail }) => detail)).toEqual(['Mod.esp (ModA): 000801:Mod.esp: no schema']);
  });
});

describe('a reference field (symbols.md, The features, story 5)', () => {
  it.each([
    ['the record types it allows', { validFormKeyTypes: ['ARMO', 'WEAP'] }, ['ARMO', 'WEAP']],
    ['none where it allows any', {}, []],
  ])('answers its span, the text typed in it before the cursor, and %s', async (_case, over, types) => {
    expect(await names([named('Reference', 41, 43, 'Gu', over)]).owner.referenceTypedAt(FILE, TEXT, 42)).toEqual({ start: 41, end: 43, typed: 'G', types });
  });
});

describe('the FormKey or EditorID Rename Symbol changes (symbols.md, The symbols, Record)', () => {
  it.each([
    ['a FormKey, between its quotes, with the plugin inside it', [OWN, named('Plugin', 21, 28, 'Mod.esp', { fieldPath: 'FormKey' })],
      { start: 14, end: 28, formKey: NPC, member: 'FormKey', plugin: { name: 'Mod.esp' } }],
    ['an EditorID, of the record that holds it', [named('EditorId', 40, 43, 'Npc', { fieldPath: 'EditorID' })], { start: 40, end: 43, formKey: NPC, member: 'EditorID' }],
    ['none elsewhere', [named('Reference', 40, 42, 'Gu')], undefined],
  ])('is %s', async (_case, answer, expected) => {
    expect(await names(answer).owner.recordMemberAt(FILE, TEXT, 20)).toEqual(expected);
  });
});

describe('where a copy\'s document names a symbol, asked of its text alone', () => {
  it('answers a record\'s own FormKey member and its own FormKey', async () => {
    const { owner } = names([named('Declaration', 2, 29, NPC, { fieldPath: 'FormKey' }), OWN]);

    expect([await owner.declarationIn(TEXT, NPC), await owner.formKeyIn(TEXT, NPC)]).toEqual([{ start: 2, end: 29 }, { start: 13, end: 29 }]);
  });

  it('fails where mEdit cannot answer, for the caller to say which copy went unread', async () => {
    await expect(names(localFailure('mEdit is down')).owner.formKeyIn(TEXT, NPC)).rejects.toThrow('mEdit is down');
  });
});
