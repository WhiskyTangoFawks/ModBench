import { describe, it, expect } from 'vitest';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { FileRead, GameFile, GameFolder, InstallationFile, InstanceAdapter, OriginFile, OriginFiles } from '../../instanceAdapter/instanceAdapter';
import { GAME_FOLDER_NOT_FOUND } from '../../test/mo2/gameFolderNotFound';
import { fakeInstanceAdapter, fileIn, readingFixture, refusing, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { modlistSourceCommands } from '../modlistSourceCommands';

const INSTALLED: InstallationFile = { path: '/downloads/ModA-1.0.7z', size: 10, hash: 'H', entries: [{ path: 'textures/a.dds', hash: 'E' }] };
const VANILLA: GameFile = { path: 'Game.esm', size: 7, hash: 'V' };
const FOUND: GameFolder = { kind: 'found', root: '/game', dataFolder: '/game/Data' };

const recording = (files: readonly InstallationFile[]): FileRead<readonly InstallationFile[]> => ({ kind: 'read', answer: files });
const instanceOf = (gameFolder: GameFolder = FOUND) => ({ gameFolder });
const filesIn = (filesByMod: Record<string, readonly OriginFile[]>): ReadonlyMap<string, OriginFiles> =>
  new Map(Object.entries(filesByMod).map(([mod, files]) => [mod, { origin: mod, folder: `/mods/${mod}`, files, folders: [], notes: [] }]));

const sentNamesOf = (mods: unknown): string[] => (Array.isArray(mods) ? mods.map((mod: { name: string }) => mod.name) : []);

function commandsOver(answers: InstanceAnswers = {}, client = new InMemoryMEditClient(), filesByMod: Record<string, readonly OriginFile[]> = {}) {
  const adapter = fakeInstanceAdapter(readingFixture({ modFiles: filesIn(filesByMod) }), answers);
  const repositories: string[] = [];
  const commands = modlistSourceCommands({
    client, adapter: adapter.adapter, instanceRoot: '/instance',
    makeRepository: () => { repositories.push('made'); return Promise.resolve(); },
  });
  return { commands, client, adapter, repositories };
}

describe('modlistSourceCommands git init', () => {
  it('writes the ignore list, then makes the instance folder a repository', async () => {
    const { commands, adapter, repositories } = commandsOver();

    const result = await commands.gitInit({ holdsRepository: false });

    expect([result.applied, adapter.calls, repositories]).toEqual([true, [{ verb: 'writeIgnoreList' }], ['made']]);
  });

  it('refuses an instance folder that already holds a repository, naming it, and changes nothing', async () => {
    const { commands, adapter, repositories } = commandsOver();

    const result = await commands.gitInit({ holdsRepository: true });

    expect([result, repositories, adapter.calls]).toEqual([{ applied: false, refusal: '/instance already holds a repository.' }, [], []]);
  });

  it('makes no repository when the ignore list could not be written, and says why', async () => {
    const { commands, repositories } = commandsOver({ refusals: refusing('writeIgnoreList', '/instance/.gitignore already exists') });

    expect([await commands.gitInit({ holdsRepository: false }), repositories]).toEqual([{ applied: false, refusal: '/instance/.gitignore already exists' }, []]);
  });

  it('takes back the ignore list it wrote when the repository could not be made, leaving nothing behind', async () => {
    const adapter = fakeInstanceAdapter();
    const commands = modlistSourceCommands({
      client: new InMemoryMEditClient(), adapter: adapter.adapter, instanceRoot: '/instance',
      makeRepository: () => Promise.reject(new Error('git is not available')),
    });

    const result = await commands.gitInit({ holdsRepository: false });

    expect([result, adapter.calls]).toEqual([
      { applied: false, refusal: 'git is not available' }, [{ verb: 'writeIgnoreList' }, { verb: 'removeIgnoreList' }],
    ]);
  });

  it('names the ignore list that remains when it could not be taken back', async () => {
    const adapter = fakeInstanceAdapter(readingFixture(), { refusals: refusing('removeIgnoreList', 'read-only folder') });
    const commands = modlistSourceCommands({
      client: new InMemoryMEditClient(), adapter: adapter.adapter, instanceRoot: '/instance',
      makeRepository: () => Promise.reject(new Error('git is not available')),
    });

    expect(await commands.gitInit({ holdsRepository: false })).toEqual({
      applied: false, refusal: 'git is not available; the ignore list it wrote remains: read-only folder',
    });
  });
});

describe('modlistSourceCommands update manifest', () => {
  const UPDATED = { landed: [{ mod: 'ModA', manifestWritten: true, noProvider: [] }], refused: [] };

  it('hands mEdit each mod with its folder, its installation files and the files the repository commits itself, the game files its files override, and the stat cache\'s folder', async () => {
    const { commands, client } = commandsOver({
      installations: new Map([['ModA', recording([INSTALLED])]]), gameFiles: [VANILLA, { path: 'Other.esm', size: 1, hash: 'O' }],
    }, new InMemoryMEditClient(), { ModA: [fileIn('/mods/ModA', 'game.ESM')], ModB: [fileIn('/mods/ModB', 'a.nif')] });
    client.setCommandResult('updateManifest', UPDATED);

    await commands.updateManifest(['ModA', 'ModB'], instanceOf());

    expect(client.calls).toEqual([{
      method: 'updateManifest',
      args: [
        [
          { name: 'ModA', folder: '/mods/ModA', installationFiles: [INSTALLED], committedFiles: ['meta.ini'] },
          { name: 'ModB', folder: '/mods/ModB', installationFiles: [], committedFiles: ['meta.ini'] },
        ],
        { gameFiles: [VANILLA], statCache: '/instance/stat-cache' },
        { onProgress: expect.any(Function) as unknown, signal: undefined },
      ],
    }]);
  });

  it('reports the phase of reading each mod\'s files, then mEdit\'s progress updating them', async () => {
    const { commands, client } = commandsOver();
    client.setCommandHandler('updateManifest', (_mods, _facts, options) => {
      options?.onProgress?.({ mod: 'ModA', modsDone: 1, modsTotal: 2 });
      return Promise.resolve(UPDATED);
    });
    const heard: unknown[] = [];

    await commands.updateManifest(['ModA', 'ModB'], instanceOf(), { onProgress: (status) => heard.push(status) });

    expect(heard).toEqual([
      { phase: 'ReadingFiles', mod: 'ModA' }, { phase: 'ReadingFiles', mod: 'ModB' }, { phase: 'Updating', mod: 'ModA', modsDone: 1, modsTotal: 2 },
    ]);
  });

  describe('refuses a mod, naming why, and updates the rest', () => {
    const adapterOf = fakeInstanceAdapter().adapter;
    const refusedFor: [string, Partial<InstanceAdapter>, string][] = [
      ['its name gives it no folder', { modFolderPath: (mod) => Promise.resolve(mod === 'ModA' ? undefined : `/mods/${mod}`) }, 'its name gives it no folder'],
      ['its installation files cannot be read', {
        installationFiles: (mod) => Promise.resolve(mod === 'ModA' ? { kind: 'unreadable', reason: 'its installation file is not indexed' } : { kind: 'read', answer: [] }),
      }, 'its installation file is not indexed'],
      ['the game files its files override cannot be read', {
        gameFilesOverriddenBy: (dataFolder, mod) => (mod === 'ModA'
          ? Promise.resolve({ kind: 'unreadable', reason: 'Game.esm is locked' })
          : adapterOf.gameFilesOverriddenBy(dataFolder, mod)),
      }, 'Game.esm is locked'],
    ];

    it.each(refusedFor)('when %s', async (_cause, override, reason) => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('updateManifest', UPDATED);
      const commands = modlistSourceCommands({
        client, adapter: { ...adapterOf, ...override }, instanceRoot: '/instance', makeRepository: () => Promise.resolve(),
      });

      const outcome = await commands.updateManifest(['ModA', 'ModB'], instanceOf());

      expect(client.calls.map((call) => sentNamesOf(call.args[0]))).toEqual([['ModB']]);
      expect(outcome).toEqual({ applied: true, ...UPDATED, refused: [{ item: 'ModA', reason }], notes: [] });
    });
  });

  it('hashes no game file for a mod refused for its folder or its installation files', async () => {
    const adapter = fakeInstanceAdapter(readingFixture(), { installations: new Map([['ModA', { kind: 'unreadable', reason: 'not indexed' }]]) });
    const hashed: string[] = [];
    const commands = modlistSourceCommands({
      client: new InMemoryMEditClient(),
      adapter: { ...adapter.adapter, gameFilesOverriddenBy: (...args) => { hashed.push(args[1]); return adapter.adapter.gameFilesOverriddenBy(...args); } },
      instanceRoot: '/instance', makeRepository: () => Promise.resolve(),
    });

    await commands.updateManifest(['ModA'], instanceOf());

    expect(hashed).toEqual([]);
  });

  it('does not call mEdit when no mod can be sent', async () => {
    const { commands, client } = commandsOver({ installations: new Map([['ModA', { kind: 'unreadable', reason: 'not indexed' }]]) });

    const outcome = await commands.updateManifest(['ModA'], instanceOf());

    expect([client.calls, outcome]).toEqual([[], { applied: true, landed: [], refused: [{ item: 'ModA', reason: 'not indexed' }], notes: [] }]);
  });

  it('names each entry a mod folder\'s listing skipped, by mod, so a game file it overrides is never left out in silence', async () => {
    const modFiles = new Map([['ModA', { origin: 'ModA', folder: '/mods/ModA', files: [], folders: [], notes: ['broken link "a.nif", skipped'] }]]);
    const client = new InMemoryMEditClient();
    client.setCommandResult('updateManifest', UPDATED);
    const commands = modlistSourceCommands({
      client, adapter: fakeInstanceAdapter(readingFixture({ modFiles })).adapter, instanceRoot: '/instance', makeRepository: () => Promise.resolve(),
    });

    expect(await commands.updateManifest(['ModA'], instanceOf())).toMatchObject({ notes: ['ModA: broken link "a.nif", skipped'] });
  });

  it('answers the refusal of the user\'s cancel beside what mEdit updated', async () => {
    const { commands, client } = commandsOver();
    client.setCommandResult('updateManifest', { ...UPDATED, cancelRefusal: 'Could not cancel — not running.' });

    expect(await commands.updateManifest(['ModA'], instanceOf())).toMatchObject({ ...UPDATED, cancelRefusal: 'Could not cancel — not running.' });
  });

  it('refuses the whole gesture with the message when mEdit refused the call', async () => {
    const { commands, client } = commandsOver();
    client.setCommandResult('updateManifest', { refused: true, message: 'Could not update the manifest of 1 mod — mEdit is not running.' });

    expect(await commands.updateManifest(['ModA'], instanceOf()))
      .toEqual({ applied: false, refusal: 'Could not update the manifest of 1 mod — mEdit is not running.' });
  });

  it('refuses the whole gesture when the game folder is not found, because a file cannot be matched to the game\'s', async () => {
    const { commands, client } = commandsOver();

    const outcome = await commands.updateManifest(['ModA'], instanceOf(GAME_FOLDER_NOT_FOUND));

    expect([client.calls, outcome]).toEqual([[], { applied: false, refusal: 'Could not update manifests: the game folder was not found.' }]);
  });

  it('reads no further mod, and hands mEdit none, once its signal aborts while it reads', async () => {
    const cancel = new AbortController();
    const { commands, client } = commandsOver();
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModA', 'ModB'], instanceOf(), {
      signal: cancel.signal, onProgress: (status) => { if (status.phase === 'ReadingFiles') cancel.abort(); },
    });

    expect([client.calls, outcome]).toEqual([[], { applied: true, landed: [], refused: [], notes: [] }]);
  });

  it('hands mEdit the signal, so a cancel stops it after the mod in hand', async () => {
    const cancel = new AbortController();
    const { commands, client } = commandsOver();
    client.setCommandResult('updateManifest', UPDATED);

    await commands.updateManifest(['ModA'], instanceOf(), { signal: cancel.signal });

    expect(client.calls.map((call) => call.args[2])).toMatchObject([{ signal: cancel.signal }]);
  });
});

describe('modlistSourceCommands restore from manifest', () => {
  const RESTORED = { landed: [{ mod: 'ModA', written: ['a.nif'] }], refused: [], notFound: [] };
  const sentNames = (client: InMemoryMEditClient): string[][] => client.calls.map((call) => sentNamesOf(call.args[0]));

  it('hands mEdit each mod with its folder and installation files, the game files its files override, and the stat cache\'s folder', async () => {
    const { commands, client } = commandsOver(
      { installations: new Map([['ModA', recording([INSTALLED])]]), gameFiles: [VANILLA] }, new InMemoryMEditClient(), { ModA: [fileIn('/mods/ModA', 'game.esm')] });
    client.setCommandResult('restoreFromManifest', RESTORED);

    await commands.restoreFromManifest(['ModA'], instanceOf());

    expect(client.calls).toEqual([{
      method: 'restoreFromManifest',
      args: [
        [{ name: 'ModA', folder: '/mods/ModA', installationFiles: [INSTALLED] }],
        { gameFiles: [VANILLA], dataFolder: '/game/Data', statCache: '/instance/stat-cache' },
        { onProgress: expect.any(Function) as unknown, signal: undefined },
      ],
    }]);
  });

  it('reports the phase of reading each mod\'s files, then mEdit\'s progress restoring them', async () => {
    const { commands, client } = commandsOver();
    client.setCommandHandler('restoreFromManifest', (_mods, _facts, options) => {
      options?.onProgress?.({ mod: 'ModA', modsDone: 0, modsTotal: 1 });
      return Promise.resolve(RESTORED);
    });
    const heard: unknown[] = [];

    await commands.restoreFromManifest(['ModA'], instanceOf(), { onProgress: (status) => heard.push(status) });

    expect(heard).toEqual([{ phase: 'ReadingFiles', mod: 'ModA' }, { phase: 'Restoring', mod: 'ModA', modsDone: 0, modsTotal: 1 }]);
  });

  it('sends a mod skipped for a game file the call did not name again, with that game file, and answers both sends as one', async () => {
    const { commands, client } = commandsOver({ gameFiles: [VANILLA] });
    const gameFileMissing = "'ModA' was skipped: game file 'Game.esm' is missing.";
    client.setCommandHandler('restoreFromManifest', (_mods, facts) => Promise.resolve(facts.gameFiles.length === 0
      ? { landed: [], refused: [{ item: 'ModA', reason: gameFileMissing }], notFound: [{ mod: 'ModA', gameFiles: ['Game.esm'] }] }
      : { landed: [{ mod: 'ModA', written: ['Game.esm'] }], refused: [], notFound: [] }));

    const outcome = await commands.restoreFromManifest(['ModA'], instanceOf());

    expect(client.calls.map((call) => call.args[1])).toMatchObject([{ gameFiles: [] }, { gameFiles: [VANILLA] }]);
    expect(outcome).toEqual({ applied: true, landed: [{ mod: 'ModA', written: ['Game.esm'] }], refused: [] });
  });

  it('names a game file still not found once the call names every game file it could', async () => {
    const { commands, client } = commandsOver();
    const gameFileMissing = "'ModA' was skipped: game file 'Gone.esm' is missing.";
    client.setCommandResult('restoreFromManifest', { landed: [], refused: [{ item: 'ModA', reason: gameFileMissing }], notFound: [{ mod: 'ModA', gameFiles: ['Gone.esm'] }] });

    const outcome = await commands.restoreFromManifest(['ModA'], instanceOf());

    expect([client.calls.length, outcome]).toEqual([2, { applied: true, landed: [], refused: [{ item: 'ModA', reason: gameFileMissing }] }]);
  });

  it('says why beside a mod still skipped for a game file the Instance adapter could not read', async () => {
    const adapter = fakeInstanceAdapter().adapter;
    const client = new InMemoryMEditClient();
    const commands = modlistSourceCommands({
      client, adapter: { ...adapter, overriddenGameFiles: (dataFolder, paths) => (paths.includes('Game.esm')
        ? Promise.resolve({ kind: 'unreadable', reason: 'Game.esm is locked' })
        : adapter.overriddenGameFiles(dataFolder, paths)) },
      instanceRoot: '/instance', makeRepository: () => Promise.resolve(),
    });
    const gameFileMissing = "'ModA' was skipped: game file 'Game.esm' is missing.";
    client.setCommandResult('restoreFromManifest', { landed: [], refused: [{ item: 'ModA', reason: gameFileMissing }], notFound: [{ mod: 'ModA', gameFiles: ['Game.esm'] }] });

    const outcome = await commands.restoreFromManifest(['ModA'], instanceOf());

    expect(outcome).toEqual({
      applied: true, landed: [], refused: [{ item: 'ModA', reason: `${gameFileMissing} The game files could not be read: Game.esm is locked.` }],
    });
  });

  it('sends no skipped mod again once its signal aborts, handing mEdit the signal, so a cancel stops after the mod in hand', async () => {
    const cancel = new AbortController();
    const { commands, client } = commandsOver({ gameFiles: [VANILLA] });
    client.setCommandHandler('restoreFromManifest', () => {
      cancel.abort();
      return Promise.resolve({ landed: [], refused: [], notFound: [{ mod: 'ModA', gameFiles: ['Game.esm'] }] });
    });

    await commands.restoreFromManifest(['ModA'], instanceOf(), { signal: cancel.signal });

    expect(client.calls.map((call) => call.args[2])).toMatchObject([{ signal: cancel.signal }]);
  });

  it('answers the refusal of the user\'s cancel beside what mEdit restored', async () => {
    const { commands, client } = commandsOver();
    client.setCommandResult('restoreFromManifest', { ...RESTORED, cancelRefusal: 'Could not cancel — not running.' });

    expect(await commands.restoreFromManifest(['ModA'], instanceOf())).toMatchObject({ cancelRefusal: 'Could not cancel — not running.' });
  });

  it('answers the refusal of a cancel during the second send beside what both sends restored', async () => {
    const { commands, client } = commandsOver({ gameFiles: [VANILLA] });
    client.setCommandHandler('restoreFromManifest', (_mods, facts) => Promise.resolve(facts.gameFiles.length === 0
      ? { landed: [], refused: [], notFound: [{ mod: 'ModA', gameFiles: ['Game.esm'] }] }
      : { landed: [{ mod: 'ModA', written: ['Game.esm'] }], refused: [], notFound: [], cancelRefusal: 'Could not cancel — not running.' }));

    expect(await commands.restoreFromManifest(['ModA'], instanceOf())).toMatchObject({ cancelRefusal: 'Could not cancel — not running.' });
  });

  it('refuses a mod the Instance adapter cannot answer, naming why, and restores the rest', async () => {
    const { commands, client } = commandsOver({ installations: new Map([['ModA', { kind: 'unreadable', reason: 'not indexed' }]]) });
    client.setCommandResult('restoreFromManifest', { landed: [{ mod: 'ModB', written: [] }], refused: [], notFound: [] });

    const outcome = await commands.restoreFromManifest(['ModA', 'ModB'], instanceOf());

    expect([sentNames(client), outcome]).toEqual([
      [['ModB']], { applied: true, landed: [{ mod: 'ModB', written: [] }], refused: [{ item: 'ModA', reason: 'not indexed' }] },
    ]);
  });

  it('names the mods mEdit had not reported done when the call failed part way', async () => {
    const { commands, client } = commandsOver();
    client.setCommandHandler('restoreFromManifest', (_mods, _facts, options) => {
      options?.onProgress?.({ mod: 'ModA', modsDone: 0, modsTotal: 3 });
      options?.onProgress?.({ mod: 'ModB', modsDone: 1, modsTotal: 3 });
      return Promise.resolve({ refused: true, message: 'Could not restore 3 mods — mEdit stopped.' });
    });

    expect(await commands.restoreFromManifest(['ModA', 'ModB', 'ModC'], instanceOf())).toEqual({
      applied: false, refusal: 'Could not restore 3 mods — mEdit stopped.', unfinished: ['ModB', 'ModC'],
    });
  });

  it('refuses the whole gesture when the game folder is not found, because a game file cannot be matched', async () => {
    const { commands, client } = commandsOver();

    const outcome = await commands.restoreFromManifest(['ModA'], instanceOf(GAME_FOLDER_NOT_FOUND));

    expect([client.calls, outcome]).toEqual([[], { applied: false, refusal: 'Could not restore from manifest: the game folder was not found.', unfinished: [] }]);
  });
});
