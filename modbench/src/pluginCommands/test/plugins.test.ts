import { describe, it, expect, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { pluginSyncOver, type PluginsDrop } from '../plugins';
import { pluginCommandsWith } from '../../test/pluginCommandsWith';
import { fakeInstanceAdapter, fileIn, refusing, readingFixture } from '../../test/fakeInstanceAdapter';
import type { ModStatus, PluginMetadata, ReadModStatus } from '../../client';
import type { ReadFailed } from '../../wire/readFailed';
import { status } from '../../test/modStatusFixture';
import { NO_MOD_STATUSES } from '../../test/noModStatuses';
import type { DataFolderPlugins, PluginOrderChange } from '../../instanceAdapter/instanceAdapter';

const PROFILE = 'Default';
const NOT_INDEXED = { getPlugins: () => Promise.reject(new Error('mEdit is indexing')) };
type Fact = { name: string; masters?: string[]; isBlueprint?: boolean; origin?: string; inLoadOrder?: boolean };
const knowing = (...facts: Fact[]) => ({
  getPlugins: () => Promise.resolve(facts.map((f): PluginMetadata => ({
    path: `/data/${f.name}`, isLight: false, isMaster: false, isImmutable: false, inLoadOrder: true,
    hasMatchingRecords: false, isCompiledPlugin: false, hasParseFailure: false, pluginSourceUnreadable: null, masters: [], isBlueprint: false, origin: 'SomeMod', ...f,
  }))),
});
const moving = (...names: string[]) => names.map((name) => ({ name, origin: 'SomeMod' }));
const lines = (...names: string[]) => names.map((name) => ({ name, enabled: true }));
const fakeOver = (...names: string[]) => fakeInstanceAdapter(readingFixture({ pluginOrder: lines(...names) }));
const handed = (changes: readonly PluginOrderChange[], profile = PROFILE) => [{ verb: 'changePluginOrder', profile, changes }];
const synced = (changes: readonly PluginOrderChange[], profile = PROFILE) => [{ verb: 'changePluginOrderOverProvided', profile, changes }];

describe('reorderPlugins hands the adapter a move decided against the order it holds', () => {
  it('a move is its plugins and the record index the drop settles to', async () => {
    const fake = fakeOver('Base.esp', 'Gone.esp');

    await pluginCommandsWith(fake.adapter, NOT_INDEXED).reorderPlugins(moving('Base.esp'), { kind: 'after', name: 'Gone.esp' });

    expect(fake.calls).toEqual(synced([{ kind: 'move', plugins: ['Base.esp'], toIndex: 1 }]));
  });

  it('a drop on a row the order does not list is refused by name, and no change is handed over', async () => {
    const fake = fakeOver('Base.esp', 'Other.esp');

    const result = await pluginCommandsWith(fake.adapter, NOT_INDEXED).reorderPlugins(moving('Other.esp'), { kind: 'before', name: 'Gone.esp' });

    expect(result).toEqual({ applied: false, refusal: 'Plugin not found in plugins.txt: Gone.esp' });
    expect(fake.calls).toEqual([]);
  });

  it.each(['B.esp', 'b.ESP'])('a drop on %s, one of the moving plugins, is refused once, and nothing is written', async (target) => {
    const fake = fakeOver('A.esp', 'B.esp', 'C.esp');

    const result = await pluginCommandsWith(fake.adapter, NOT_INDEXED).reorderPlugins(moving('A.esp', 'B.esp'), { kind: 'before', name: target });

    expect(result).toEqual({ applied: false, refusal: `The target is "${target}", which is moving.` });
    expect(fake.calls).toEqual([]);
  });

  it('a refusal by the adapter is the refusal the command returns', async () => {
    const fake = fakeInstanceAdapter(readingFixture({ pluginOrder: lines('Base.esp') }), { refusals: refusing('changePluginOrderOverProvided', 'ENOENT: no plugins.txt') });

    const result = await pluginCommandsWith(fake.adapter, NOT_INDEXED).reorderPlugins(moving('Base.esp'), { kind: 'losingEnd' });

    expect(result).toEqual({ applied: false, refusal: 'ENOENT: no plugins.txt' });
  });

  describe('the plugin-order rules, held against the order the move lands on', () => {
    const THREE = ['A.esp', 'B.esp', 'C.esp'];
    const FIVE = ['A.esp', 'B.esp', 'C.esp', 'D.esp', 'E.esp'];
    const plain = (names: readonly string[], special: Record<string, Partial<Fact>> = {}): Fact[] =>
      names.map((name) => ({ name, ...special[name] }));
    const AB = plain(THREE, { 'B.esp': { masters: ['A.esp'] } });
    const masterOf = (master: string, dependant: string) => `"${master}" is a master of "${dependant}", so it must load before it.`;

    interface Move { order: readonly string[]; facts: Fact[]; moved: string; drop: PluginsDrop; withNoLine?: string[] }
    const run = async ({ order, facts, moved, drop, withNoLine = [] }: Move) => {
      const fake = fakeInstanceAdapter(readingFixture({ pluginOrder: lines(...order), dataFolderPlugins: { kind: 'listed', names: new Set(withNoLine) } }));
      const result = await pluginCommandsWith(fake.adapter, knowing(...facts)).reorderPlugins(moving(moved), drop);
      return { fake, result };
    };

    it.each<[string, Move, string]>([
      ['a master dropped below its dependant', { order: THREE, facts: AB, moved: 'A.esp', drop: { kind: 'winningEnd' } }, masterOf('A.esp', 'B.esp')],
      ['a master named in another case than its line', { order: THREE, facts: plain(THREE, { 'B.esp': { masters: ['a.ESP'] } }), moved: 'A.esp', drop: { kind: 'winningEnd' } }, masterOf('A.esp', 'B.esp')],
      ['a master dropped directly after its dependant', { order: THREE, facts: AB, moved: 'A.esp', drop: { kind: 'after', name: 'B.esp' } }, masterOf('A.esp', 'B.esp')],
      ['a blueprint plugin dropped before one that is not', { order: THREE, facts: plain(THREE, { 'C.esp': { isBlueprint: true } }), moved: 'C.esp', drop: { kind: 'losingEnd' } },
        '"C.esp" is a blueprint plugin, so it must load after "A.esp", which is not.'],
      ['a plugin that is not a blueprint moved past one', { order: FIVE, facts: plain(FIVE, { 'E.esp': { isBlueprint: true } }), moved: 'C.esp', drop: { kind: 'winningEnd' } },
        '"E.esp" is a blueprint plugin, so it must load after "C.esp", which is not.'],
      ['a blueprint master dropped below the blueprint plugin that depends on it',
        { order: FIVE, facts: plain(FIVE, { 'D.esp': { isBlueprint: true }, 'E.esp': { isBlueprint: true, masters: ['D.esp'] } }), moved: 'D.esp', drop: { kind: 'winningEnd' } }, masterOf('D.esp', 'E.esp')],
      ['a name two origins hold, judged by the copy in the load order',
        { order: THREE, facts: [{ name: 'A.esp' }, { name: 'B.esp', origin: 'Other', inLoadOrder: false }, { name: 'B.esp', masters: ['A.esp'] }, { name: 'C.esp' }], moved: 'A.esp', drop: { kind: 'winningEnd' } },
        masterOf('A.esp', 'B.esp')],
      ['a disabled plugin held once, which is not in the load order',
        { order: THREE, facts: plain(THREE, { 'B.esp': { masters: ['A.esp'], inLoadOrder: false } }), moved: 'A.esp', drop: { kind: 'winningEnd' } }, masterOf('A.esp', 'B.esp')],
    ])('refuses %s, and hands the adapter no change', async (_, move, refusal) => {
      const { fake, result } = await run(move);

      expect(result).toEqual({ applied: false, refusal });
      expect(fake.calls).toEqual([]);
    });

    it.each<[string, Move]>([
      ['a dependant dropped directly after its master', { order: THREE, facts: AB, moved: 'B.esp', drop: { kind: 'after', name: 'A.esp' } }],
      ['a plugin whose masters mEdit does not list', { order: THREE, facts: [{ name: 'A.esp' }], moved: 'A.esp', drop: { kind: 'winningEnd' } }],
      ['a plugin that is not a blueprint before its blueprint master, which only holds master order within one class',
        { order: FIVE, facts: plain(FIVE, { 'B.esp': { isBlueprint: true }, 'D.esp': { masters: ['B.esp'] } }), moved: 'D.esp', drop: { kind: 'before', name: 'B.esp' } }],
      ['a drop that leaves an order as it found it',
        { order: FIVE, facts: plain(FIVE, { 'A.esp': { masters: ['B.esp'] } }), moved: 'D.esp', drop: { kind: 'before', name: 'C.esp' } }],
      ['a plugin to the losing end past a master the game loads with no line',
        { order: ['DLCRobot.esm', 'A.esp', 'X.esp'], facts: plain(['DLCRobot.esm', 'A.esp', 'X.esp'], { 'X.esp': { masters: ['Fallout4.esm', 'DLCRobot.esm'] } }), moved: 'X.esp', drop: { kind: 'losingEnd' }, withNoLine: ['DLCRobot.esm'] }],
      ['a name two origins hold when neither is in the load order',
        { order: THREE, facts: [{ name: 'A.esp' }, { name: 'B.esp', origin: 'Other', inLoadOrder: false }, { name: 'B.esp', masters: ['A.esp'], inLoadOrder: false }, { name: 'C.esp' }], moved: 'A.esp', drop: { kind: 'winningEnd' } }],
    ])('lets %s land', async (_, move) => {
      const { fake, result } = await run(move);

      expect(result).toMatchObject({ applied: true });
      expect(fake.calls).toHaveLength(1);
    });

    it('lets a drop land while mEdit cannot say any masters', async () => {
      const fake = fakeOver(...THREE);

      const result = await pluginCommandsWith(fake.adapter, NOT_INDEXED).reorderPlugins(moving('A.esp'), { kind: 'winningEnd' });

      expect(result).toMatchObject({ applied: true });
    });
  });
});

describe('plugin participation is a change for each plugin the order lists', () => {
  const ORDER = ['Base.esp', 'Other.esp'];

  it('enable or disable gives every named plugin one state', async () => {
    const fake = fakeOver(...ORDER);

    const result = await pluginCommandsWith(fake.adapter).setPluginsEnabled(ORDER, false);

    expect(result).toEqual({ applied: true, outcome: { landed: ORDER, refused: [] } });
    expect(fake.calls).toEqual(handed([{ kind: 'enable', plugin: 'Base.esp', enabled: false }, { kind: 'enable', plugin: 'Other.esp', enabled: false }]));
  });

  it('the check box gives each named plugin its own state', async () => {
    const fake = fakeOver(...ORDER);

    const result = await pluginCommandsWith(fake.adapter).setPluginsParticipation([{ name: 'Base.esp', enabled: false }, { name: 'Other.esp', enabled: true }]);

    expect(result).toEqual({ applied: true, outcome: { landed: ORDER, refused: [] } });
    expect(fake.calls).toEqual(handed([{ kind: 'enable', plugin: 'Base.esp', enabled: false }, { kind: 'enable', plugin: 'Other.esp', enabled: true }]));
  });

  it('writes the profile the mod manager selects', async () => {
    const fake = fakeInstanceAdapter(readingFixture({ profile: 'Other', pluginOrder: lines(...ORDER) }));

    await pluginCommandsWith(fake.adapter).setPluginsEnabled(['Base.esp'], false);

    expect(fake.calls).toEqual(handed([{ kind: 'enable', plugin: 'Base.esp', enabled: false }], 'Other'));
  });

  it('a plugin named in another case than its line lands, for the check box and for enable alike', async () => {
    const fake = fakeOver(...ORDER);
    const commands = pluginCommandsWith(fake.adapter);

    const checkbox = await commands.setPluginsParticipation([{ name: 'base.ESP', enabled: false }]);
    const enable = await commands.setPluginsEnabled(['other.esp'], true);

    expect([checkbox, enable]).toEqual([
      { applied: true, outcome: { landed: ['base.ESP'], refused: [] } },
      { applied: true, outcome: { landed: ['other.esp'], refused: [] } },
    ]);
  });

  it('a plugin the order does not list is refused by name, and the rest still land in the one change', async () => {
    const fake = fakeOver(...ORDER);

    const result = await pluginCommandsWith(fake.adapter).setPluginsEnabled(['Base.esp', 'No Such.esp'], false);

    expect(result).toEqual({
      applied: true,
      outcome: { landed: ['Base.esp'], refused: [{ item: 'No Such.esp', reason: 'Plugin not found in plugins.txt: No Such.esp' }] },
    });
    expect(fake.calls).toEqual(handed([{ kind: 'enable', plugin: 'Base.esp', enabled: false }]));
  });

  it('a refusal by the adapter refuses the whole selection', async () => {
    const fake = fakeInstanceAdapter(readingFixture({ pluginOrder: lines(...ORDER) }), { refusals: refusing('changePluginOrder', 'ENOENT: no plugins.txt') });

    expect(await pluginCommandsWith(fake.adapter).setPluginsEnabled(ORDER, false)).toEqual({ applied: false, refusal: 'ENOENT: no plugins.txt' });
  });
});

describe('syncPlugins decides the lines plugins.txt converges on, from what the Instance adapter says is provided', () => {
  const inData = (...names: string[]): DataFolderPlugins => ({ kind: 'listed', names: new Set(names) });

  interface Run {
    order?: readonly string[]; provided?: readonly string[]; inData?: DataFolderPlugins; gameRelease?: string; creationClubList?: readonly string[];
    profile?: string;
    repository?: { statuses: readonly ModStatus[] | ReadFailed; lastAnswered?: readonly ModStatus[] };
    otherMod?: { name: string; enabled: boolean };
  }
  const sync = async ({
    order = [], provided = [], inData: data = inData(), gameRelease = 'Fallout4', creationClubList = [], profile = PROFILE, repository,
    otherMod = { name: 'Unrestored', enabled: true },
  }: Run) => {
    const fake = fakeInstanceAdapter(readingFixture({
      profile, gameRelease, creationClubList, pluginOrder: lines(...order), dataFolderPlugins: data,
      mods: [{ kind: 'mod', name: 'Provider', enabled: true }, { kind: 'mod', ...otherMod }],
      modFiles: new Map([['Provider', { origin: 'Provider', folder: '/mods/Provider', files: provided.map((name) => fileIn('/mods/Provider', name)), folders: [], notes: [] }]]),
    }), { repositoryOnDisk: repository !== undefined });
    const asked: string[][] = [];
    const readStatus: ReadModStatus = (mods) => {
      asked.push([...mods]);
      return Promise.resolve(repository?.statuses ?? []);
    };
    const lastStatus = (mod: string) => repository?.lastAnswered?.find((answered) => answered.mod === mod);
    const result = await pluginSyncOver(fake.adapter, readStatus, { of: lastStatus })();
    return { fake, result, asked };
  };
  const handedChanges = (fake: ReturnType<typeof fakeInstanceAdapter>) =>
    fake.calls.flatMap((call) => (call.verb === 'changePluginOrderOverProvided' ? call.changes : []));

  it('keeps the line of a plugin an enabled mod\'s manifest names and its folder lacks', async () => {
    const { fake, result } = await sync({
      order: ['Base.esp', 'Unrestored.esp', 'Gone.esp'], provided: ['Base.esp'],
      repository: { statuses: [status('Provider'), status('Unrestored', { gone: ['Unrestored.esp'] })] },
    });

    expect(result).toEqual({ applied: true, wrote: true, added: [], dropped: ['Gone.esp'] });
    expect(handedChanges(fake)).toEqual([{ kind: 'drop', plugin: 'Gone.esp' }]);
  });

  it('appends a line for a plugin mEdit last named in a manifest with none, and none for a file named below the folder\'s root', async () => {
    const { result } = await sync({
      order: ['Base.esp'], provided: ['Base.esp'],
      repository: { statuses: [], lastAnswered: [status('Unrestored', { gone: ['Unrestored.esp', 'optional/Nested.esp'] })] },
    });

    expect(result).toEqual({ applied: true, wrote: true, added: ['Unrestored.esp'], dropped: [] });
  });

  it('asks mEdit nothing when what is on disk drops no line', async () => {
    const { result, asked } = await sync({ order: ['Base.esp'], provided: ['Base.esp', 'New.esp'], repository: { statuses: [status('Provider')] } });

    expect(result).toEqual({ applied: true, wrote: true, added: ['New.esp'], dropped: [] });
    expect(asked).toEqual([]);
  });

  it('decides a drop on the manifests mEdit names now, not on its last answer', async () => {
    const { result } = await sync({
      order: ['Base.esp', 'Unrestored.esp'], provided: ['Base.esp'],
      repository: { statuses: [status('Unrestored')], lastAnswered: [status('Unrestored', { gone: ['Unrestored.esp'] })] },
    });

    expect(result).toEqual({ applied: true, wrote: true, added: [], dropped: ['Unrestored.esp'] });
  });

  it('drops the line of a plugin only a disabled mod\'s manifest names', async () => {
    const { result } = await sync({
      order: ['Base.esp', 'Off.esp'], provided: ['Base.esp'], otherMod: { name: 'Off', enabled: false },
      repository: { statuses: [status('Off', { gone: ['Off.esp'] })] },
    });

    expect(result).toEqual({ applied: true, wrote: true, added: [], dropped: ['Off.esp'] });
  });

  it('asks mEdit nothing while the instance holds no repository', async () => {
    const { result, asked } = await sync({ order: ['Base.esp', 'Gone.esp'], provided: ['Base.esp'] });

    expect(result).toEqual({ applied: true, wrote: true, added: [], dropped: ['Gone.esp'] });
    expect(asked).toEqual([]);
  });

  it.each<[string, readonly ModStatus[] | ReadFailed, string]>([
    ['mEdit could not read the manifests', { failed: 'unreachable' }, "the mods' manifests could not be read: mEdit could not be reached."],
    ['the status of one enabled mod could not be read', [status('Provider'), status('Unrestored', { unreadable: { manifest: true, why: 'bad line 3' } })],
      'the status of "Unrestored" could not be read: bad line 3'],
  ])('refuses, handing over no change, when a line nothing on disk provides waits on a manifest and %s', async (_, statuses, refusal) => {
    const { fake, result } = await sync({ order: ['Base.esp', 'Unrestored.esp'], provided: ['Base.esp', 'New.esp'], repository: { statuses } });

    expect(result).toEqual({ applied: false, refusal });
    expect(handedChanges(fake)).toEqual([]);
  });

  it('refuses when a line nothing on disk provides waits on a mod enabled after the manifests were asked', async () => {
    const fake = fakeInstanceAdapter(readingFixture({ pluginOrder: lines('Late.esp'), dataFolderPlugins: inData(), mods: [] }), { repositoryOnDisk: true });
    const enablingLate: ReadModStatus = () => {
      fake.read({ mods: [{ kind: 'mod', name: 'Late', enabled: true }] });
      return Promise.resolve([]);
    };

    const result = await pluginSyncOver(fake.adapter, enablingLate, NO_MOD_STATUSES)();

    expect(result).toEqual({ applied: false, refusal: 'the manifest of "Late" was not read' });
  });

  it('appends a line for every provided plugin with none, in ascending case-folded order', async () => {
    const { fake, result } = await sync({ order: ['Base.esp'], provided: ['Base.esp', 'zeta.esp', 'Alpha.esl'] });

    expect(result).toEqual({ applied: true, wrote: true, added: ['Alpha.esl', 'zeta.esp'], dropped: [] });
    expect(fake.calls).toEqual(synced([{ kind: 'add', plugin: 'Alpha.esl' }, { kind: 'add', plugin: 'zeta.esp' }]));
  });

  it('drops a line whose plugin nothing provides, and keeps one the game Data folder provides', async () => {
    const { fake, result } = await sync({ order: ['Base.esp', 'Gone.esp', 'DLCCoast.esm'], provided: ['Base.esp'], inData: inData('DLCCoast.esm') });

    expect(result).toEqual({ applied: true, wrote: true, added: [], dropped: ['Gone.esp'] });
    expect(fake.calls).toEqual(synced([{ kind: 'drop', plugin: 'Gone.esp' }]));
  });

  it('writes the profile the mod manager selects', async () => {
    const { fake } = await sync({ order: ['Gone.esp'], profile: 'Other' });

    expect(fake.calls).toEqual(synced([{ kind: 'drop', plugin: 'Gone.esp' }], 'Other'));
  });

  it('appends a line for a plugin in the game\'s Data folder with none, as for a mod\'s', async () => {
    const { fake, result } = await sync({ order: ['Base.esp'], provided: ['Base.esp'], inData: inData('Loose.esp') });

    expect(result).toEqual({ applied: true, wrote: true, added: ['Loose.esp'], dropped: [] });
    expect(fake.calls).toEqual(synced([{ kind: 'add', plugin: 'Loose.esp' }]));
  });

  it.each<[string, Run]>([
    ['a plugin the game loads with no line is in the Data folder', {
      order: ['Base.esp'], provided: ['Base.esp'], inData: inData('DLCCoast.esm', 'ccBGSFO4044-HellfirePowerArmor.esl'),
      creationClubList: ['ccBGSFO4044-HellfirePowerArmor.esl'],
    }],
    ['a line differing only in case from the provided name is the same plugin', { order: ['BASE.esp'], provided: ['Base.esp'] }],
  ])('hands over no change when %s', async (_, run) => {
    const { fake, result } = await sync(run);

    expect(result).toEqual({ applied: true, wrote: false, added: [], dropped: [] });
    expect(fake.calls).toEqual(synced([]));
  });

  it.each<[string, string, string, string[]]>([
    ['is never appended when an enabled mod also ships it', 'Fallout4.esm', 'Fallout4', []],
    ['is matched to a mod\'s plugin of that name ignoring case', 'FALLOUT4.ESM', 'Fallout4', []],
    ['is appended as an ordinary plugin when the game does not load it with no line', 'Fallout4.esm', 'Oblivion', ['Fallout4.esm']],
  ])('a mod-shipped vanilla plugin %s', async (_, shipped, gameRelease, added) => {
    const { result } = await sync({ order: ['Base.esp'], provided: ['Base.esp', shipped], inData: inData('Fallout4.esm'), gameRelease });

    expect(result).toMatchObject({ applied: true, added });
  });

  it('refuses when the Data folder resolved and could not be read, handing over no change', async () => {
    const { fake, result } = await sync({ order: ['Base.esp', 'Gone.esp'], provided: ['Base.esp', 'New.esp'], inData: { kind: 'unreadable', reason: 'ENOENT: no such file or directory' } });

    expect(result).toEqual({ applied: false, refusal: "the game's Data folder cannot be listed: ENOENT: no such file or directory" });
    expect(fake.calls).toEqual([]);
  });

  it('hands over no change when the game folder is not found, leaving the telling to the instance\'s state', async () => {
    const { fake, result } = await sync({ order: ['Base.esp', 'Gone.esp'], provided: ['Base.esp', 'New.esp'], inData: { kind: 'unresolved' } });

    expect(result).toEqual({ applied: false, toldAsInstanceState: true });
    expect(fake.calls).toEqual(synced([]));
  });
});
