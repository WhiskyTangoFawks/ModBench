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
const instanceOf = (gameFolder: GameFolder = FOUND, sourceDirs: ReadonlyMap<string, string> = new Map()) =>
  ({ gameFolder, gameRelease: undefined, paths: { sourceDirs } });
const filesIn = (filesByMod: Record<string, readonly OriginFile[]>): ReadonlyMap<string, OriginFiles> =>
  new Map(Object.entries(filesByMod).map(([mod, files]) => [mod, { origin: mod, folder: `/mods/${mod}`, files, folders: [], notes: [] }]));

const sentNamesOf = (mods: unknown): string[] => (Array.isArray(mods) ? mods.map((mod: { name: string }) => mod.name) : []);

function commandsOver(answers: InstanceAnswers = {}, client = new InMemoryMEditClient(), filesByMod: Record<string, readonly OriginFile[]> = {}) {
  const adapter = fakeInstanceAdapter(readingFixture({ modFiles: filesIn(filesByMod) }), answers);
  const repositories: string[] = [];
  const commands = modlistSourceCommands({
    client, adapter: adapter.adapter, instanceRoot: '/instance',
    makeRepository: () => { repositories.push('made'); return Promise.resolve(); }, trash: () => Promise.resolve(),
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
      makeRepository: () => Promise.reject(new Error('git is not available')), trash: () => Promise.resolve(),
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
      makeRepository: () => Promise.reject(new Error('git is not available')), trash: () => Promise.resolve(),
    });

    expect(await commands.gitInit({ holdsRepository: false })).toEqual({
      applied: false, refusal: 'git is not available; the ignore list it wrote remains: read-only folder',
    });
  });
});

describe('modlistSourceCommands update manifest', () => {
  const UPDATED = { landed: [{ mod: 'ModA', manifestWritten: true, noProvider: [] }], refused: [] };

  it('hands mEdit each mod with its folder, its installation files, the files the repository commits itself and whether it is a source mod, the game files its files override, and the stat cache\'s folder', async () => {
    const { commands, client } = commandsOver({
      installations: new Map([['ModA', recording([INSTALLED])]]), gameFiles: [VANILLA, { path: 'Other.esm', size: 1, hash: 'O' }],
      metadata: new Map([['ModA', { version: '1.2.3', installationFiles: [] }]]),
    }, new InMemoryMEditClient(), { ModA: [fileIn('/mods/ModA', 'game.ESM')], ModB: [fileIn('/mods/ModB', 'a.nif')] });
    client.setCommandResult('updateManifest', UPDATED);

    await commands.updateManifest(['ModA', 'ModB'], instanceOf(FOUND, new Map([['ModB', '/source/Old ModB']])));

    expect(client.calls).toEqual([{
      method: 'updateManifest',
      args: [
        [
          { name: 'ModA', folder: '/mods/ModA', installationFiles: [INSTALLED], metadataFiles: ['meta.ini'], isSourceMod: false, version: '1.2.3' },
          { name: 'ModB', folder: '/mods/ModB', installationFiles: [], metadataFiles: ['meta.ini'], isSourceMod: true },
        ],
        { gameFiles: [VANILLA], statCache: '/instance/stat-cache' },
        { onProgress: expect.any(Function) as unknown, signal: undefined },
      ],
    }]);
  });

  it('refuses a mod whose metadata cannot be read, naming why, and updates the rest', async () => {
    const { commands, client } = commandsOver({ unreadableMetadata: new Map([['ModA', 'EISDIR: meta.ini']]) });
    client.setCommandResult('updateManifest', { landed: [{ mod: 'ModB', manifestWritten: true, noProvider: [] }], refused: [] });

    const outcome = await commands.updateManifest(['ModA', 'ModB'], instanceOf());

    expect(client.calls.map((call) => sentNamesOf(call.args[0]))).toEqual([['ModB']]);
    expect(outcome).toMatchObject({ applied: true, refused: [{ item: 'ModA', reason: 'its metadata could not be read: EISDIR: meta.ini' }] });
  });

  it('names a mod whose installation file comes from a game without a Nexus domain, and sends the file without that fact', async () => {
    const { commands, client } = commandsOver({ installations: new Map([['ModA', recording([{ ...INSTALLED, unsourcedGame: 'EnderalSE' }])]]) });
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModA'], instanceOf());

    expect(outcome).toMatchObject({ notes: [expect.stringContaining("ModA: its installation file comes from 'EnderalSE'")] });
    expect(client.calls[0]?.args[0]).toEqual([expect.objectContaining({ installationFiles: [INSTALLED] })]);
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
        client, adapter: { ...adapterOf, ...override }, instanceRoot: '/instance', makeRepository: () => Promise.resolve(), trash: () => Promise.resolve(),
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
      instanceRoot: '/instance', makeRepository: () => Promise.resolve(), trash: () => Promise.resolve(),
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
      client, adapter: fakeInstanceAdapter(readingFixture({ modFiles })).adapter, instanceRoot: '/instance', makeRepository: () => Promise.resolve(), trash: () => Promise.resolve(),
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
  const RESTORED = { landed: [{ mod: 'ModA', written: ['a.nif'], namedByNoLine: [] }], refused: [], notFound: [] };
  const INSTALLATION_FILE_MISSING = "'ModA' was skipped: installation file 'ModA-1.0.7z' is missing.";
  const sentNames = (client: InMemoryMEditClient): string[][] => client.calls.map((call) => sentNamesOf(call.args[0]));

  it('hands mEdit each mod with its folder and no installation file its metadata names, the files the repository commits itself and the folder its source is in or is cloned into, the game files its files override, the stat cache\'s folder and what a build needs', async () => {
    const { commands, client } = commandsOver(
      { installations: new Map([['ModA', recording([INSTALLED])]]), gameFiles: [VANILLA], metadata: new Map([['ModA', { version: '1.2.3', installationFiles: [] }]]) }, new InMemoryMEditClient(), { ModA: [fileIn('/mods/ModA', 'game.esm')] });
    client.setCommandResult('restoreFromManifest', RESTORED);

    await commands.restoreFromManifest(['ModA', 'ModB'], instanceOf(FOUND, new Map([['ModB', '/source/Old ModB']])));

    expect(client.calls).toEqual([{
      method: 'restoreFromManifest',
      args: [
        [
          { name: 'ModA', folder: '/mods/ModA', installationFiles: [], metadataFiles: ['meta.ini'], sourceFolder: '/source/ModA' },
          { name: 'ModB', folder: '/mods/ModB', installationFiles: [], metadataFiles: ['meta.ini'], sourceFolder: '/source/Old ModB' },
        ],
        { gameFiles: [VANILLA], dataFolder: '/game/Data', statCache: '/instance/stat-cache', excludedSuffix: '.excluded', archives: null },
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
      ? { landed: [], refused: [{ item: 'ModA', reason: gameFileMissing }], notFound: [{ mod: 'ModA', gameFiles: ['Game.esm'], installationFiles: [] }] }
      : { landed: [{ mod: 'ModA', written: ['Game.esm'], namedByNoLine: [] }], refused: [], notFound: [] }));

    const outcome = await commands.restoreFromManifest(['ModA'], instanceOf());

    expect(client.calls.map((call) => call.args[1])).toMatchObject([{ gameFiles: [] }, { gameFiles: [VANILLA] }]);
    expect(outcome).toEqual({ applied: true, landed: [{ mod: 'ModA', written: ['Game.esm'], namedByNoLine: [] }], refused: [] });
  });

  it('sends a mod skipped for an installation file the call did not hand again, with the downloaded file of that name, and answers both sends as one', async () => {
    const { commands, client } = commandsOver({ downloads: new Map([['ModA-1.0.7z', { kind: 'read', answer: INSTALLED }]]) });
    client.setCommandHandler('restoreFromManifest', (mods) => Promise.resolve(mods[0]?.installationFiles.length === 0
      ? { landed: [], refused: [{ item: 'ModA', reason: INSTALLATION_FILE_MISSING }], notFound: [{ mod: 'ModA', gameFiles: [], installationFiles: ['ModA-1.0.7z'] }] }
      : RESTORED));

    const outcome = await commands.restoreFromManifest(['ModA'], instanceOf());

    expect(client.calls.map((call) => call.args[0])).toMatchObject([[{ installationFiles: [] }], [{ installationFiles: [INSTALLED] }]]);
    expect(outcome).toEqual({ applied: true, landed: RESTORED.landed, refused: [] });
  });

  it('says why beside a mod still skipped for an installation file the Instance adapter could not read', async () => {
    const { commands, client } = commandsOver({ downloads: new Map([['ModA-1.0.7z', { kind: 'unreadable', reason: 'EACCES' }]]) });
    client.setCommandResult('restoreFromManifest', {
      landed: [], refused: [{ item: 'ModA', reason: INSTALLATION_FILE_MISSING }], notFound: [{ mod: 'ModA', gameFiles: [], installationFiles: ['ModA-1.0.7z'] }],
    });

    const outcome = await commands.restoreFromManifest(['ModA'], instanceOf());

    expect(outcome).toEqual({ applied: true, landed: [], refused: [{ item: 'ModA', reason: `${INSTALLATION_FILE_MISSING} 'ModA-1.0.7z' could not be read: EACCES.` }] });
  });

  it('names a game file still not found once the call names every game file it could', async () => {
    const { commands, client } = commandsOver();
    const gameFileMissing = "'ModA' was skipped: game file 'Gone.esm' is missing.";
    client.setCommandResult('restoreFromManifest', { landed: [], refused: [{ item: 'ModA', reason: gameFileMissing }], notFound: [{ mod: 'ModA', gameFiles: ['Gone.esm'], installationFiles: [] }] });

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
      instanceRoot: '/instance', makeRepository: () => Promise.resolve(), trash: () => Promise.resolve(),
    });
    const gameFileMissing = "'ModA' was skipped: game file 'Game.esm' is missing.";
    client.setCommandResult('restoreFromManifest', { landed: [], refused: [{ item: 'ModA', reason: gameFileMissing }], notFound: [{ mod: 'ModA', gameFiles: ['Game.esm'], installationFiles: [] }] });

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
      return Promise.resolve({ landed: [], refused: [], notFound: [{ mod: 'ModA', gameFiles: ['Game.esm'], installationFiles: [] }] });
    });

    await commands.restoreFromManifest(['ModA'], instanceOf(), { signal: cancel.signal });

    expect(client.calls.map((call) => call.args[2])).toMatchObject([{ signal: cancel.signal }]);
  });

  it('names each mod a cancel left unfinished, the one it never sent again and the one mEdit never reached, beside the mod that landed', async () => {
    const cancel = new AbortController();
    const { commands, client } = commandsOver();
    client.setCommandHandler('restoreFromManifest', () => {
      cancel.abort();
      return Promise.resolve({
        landed: RESTORED.landed, refused: [{ item: 'ModB', reason: "'ModB' was skipped: installation file 'ModB.7z' is missing." }],
        notFound: [{ mod: 'ModB', gameFiles: [], installationFiles: ['ModB.7z'] }],
      });
    });

    const outcome = await commands.restoreFromManifest(['ModA', 'ModB', 'ModC'], instanceOf(), { signal: cancel.signal });

    expect(outcome).toEqual({
      applied: true, landed: RESTORED.landed,
      refused: ['ModB', 'ModC'].map((mod) => ({ item: mod, reason: `'${mod}' was not finished: the restore was cancelled. Restoring it again finishes it.` })),
    });
  });

  it('names each mod a cancel stopped before it was read as unfinished', async () => {
    const cancel = new AbortController();
    const { commands } = commandsOver();

    const outcome = await commands.restoreFromManifest(['ModA'], instanceOf(), { signal: cancel.signal, onProgress: () => { cancel.abort(); } });

    expect(outcome).toEqual({
      applied: true, landed: [], refused: [{ item: 'ModA', reason: "'ModA' was not finished: the restore was cancelled. Restoring it again finishes it." }],
    });
  });

  it('answers the refusal of the user\'s cancel beside what mEdit restored', async () => {
    const { commands, client } = commandsOver();
    client.setCommandResult('restoreFromManifest', { ...RESTORED, cancelRefusal: 'Could not cancel — not running.' });

    expect(await commands.restoreFromManifest(['ModA'], instanceOf())).toMatchObject({ cancelRefusal: 'Could not cancel — not running.' });
  });

  it('answers the refusal of a cancel during the second send beside what both sends restored', async () => {
    const { commands, client } = commandsOver({ gameFiles: [VANILLA] });
    client.setCommandHandler('restoreFromManifest', (_mods, facts) => Promise.resolve(facts.gameFiles.length === 0
      ? { landed: [], refused: [], notFound: [{ mod: 'ModA', gameFiles: ['Game.esm'], installationFiles: [] }] }
      : { landed: [{ mod: 'ModA', written: ['Game.esm'], namedByNoLine: [] }], refused: [], notFound: [], cancelRefusal: 'Could not cancel — not running.' }));

    expect(await commands.restoreFromManifest(['ModA'], instanceOf())).toMatchObject({ cancelRefusal: 'Could not cancel — not running.' });
  });

  it('refuses a mod the Instance adapter cannot answer, naming why, and restores the rest', async () => {
    const adapter = fakeInstanceAdapter().adapter;
    const client = new InMemoryMEditClient();
    const commands = modlistSourceCommands({
      client, adapter: { ...adapter, gameFilesOverriddenBy: (dataFolder, mod) => (mod === 'ModA'
        ? Promise.resolve({ kind: 'unreadable', reason: 'Game.esm is locked' })
        : adapter.gameFilesOverriddenBy(dataFolder, mod)) },
      instanceRoot: '/instance', makeRepository: () => Promise.resolve(), trash: () => Promise.resolve(),
    });
    client.setCommandResult('restoreFromManifest', { landed: [{ mod: 'ModB', written: [], namedByNoLine: [] }], refused: [], notFound: [] });

    const outcome = await commands.restoreFromManifest(['ModA', 'ModB'], instanceOf());

    expect([sentNames(client), outcome]).toEqual([
      [['ModB']], { applied: true, landed: [{ mod: 'ModB', written: [], namedByNoLine: [] }], refused: [{ item: 'ModA', reason: 'Game.esm is locked' }] },
    ]);
  });

  it('names every mod of a call that failed part way as not finished, since none had its files no line names trashed', async () => {
    const { commands, client } = commandsOver();
    client.setCommandHandler('restoreFromManifest', (_mods, _facts, options) => {
      options?.onProgress?.({ mod: 'ModA', modsDone: 0, modsTotal: 3 });
      options?.onProgress?.({ mod: 'ModB', modsDone: 1, modsTotal: 3 });
      return Promise.resolve({ refused: true, message: 'Could not restore 3 mods — mEdit stopped.' });
    });

    expect(await commands.restoreFromManifest(['ModA', 'ModB', 'ModC'], instanceOf())).toEqual({
      applied: false, refusal: 'Could not restore 3 mods — mEdit stopped.', unfinished: ['ModA', 'ModB', 'ModC'],
    });
  });

  it('trashes the files no line names of each mod the first call landed when the second call fails, and names the second call\'s mods', async () => {
    const { commands, client, adapter } = commandsOver({ gameFiles: [VANILLA] });
    client.setCommandHandler('restoreFromManifest', (_mods, facts) => Promise.resolve(facts.gameFiles.length === 0
      ? { landed: [{ mod: 'ModA', written: [], namedByNoLine: ['mine.txt'] }], refused: [], notFound: [{ mod: 'ModB', gameFiles: ['Game.esm'], installationFiles: [] }] }
      : { refused: true as const, message: 'Could not restore 1 mod — mEdit stopped.' }));

    const outcome = await commands.restoreFromManifest(['ModA', 'ModB'], instanceOf());

    expect([adapter.calls, outcome]).toEqual([
      [{ verb: 'trashModFile', mod: 'ModA', relativePath: 'mine.txt' }],
      { applied: false, refusal: 'Could not restore 1 mod — mEdit stopped.', unfinished: ['ModB'] },
    ]);
  });

  it('sends each file no line names in a mod that landed to the trash, through the Instance adapter', async () => {
    const { commands, client, adapter } = commandsOver();
    client.setCommandResult('restoreFromManifest', { landed: [{ mod: 'ModA', written: [], namedByNoLine: ['mine.txt', 'meshes/b.nif'] }], refused: [], notFound: [] });

    await commands.restoreFromManifest(['ModA'], instanceOf());

    expect(adapter.calls).toEqual([
      { verb: 'trashModFile', mod: 'ModA', relativePath: 'mine.txt' }, { verb: 'trashModFile', mod: 'ModA', relativePath: 'meshes/b.nif' },
    ]);
  });

  it('answers a mod with a file the trash refused as not finished, naming the file and why', async () => {
    const { commands, client } = commandsOver({ refusals: refusing('trashModFile', 'the trash is full') });
    client.setCommandResult('restoreFromManifest', { landed: [{ mod: 'ModA', written: [], namedByNoLine: ['mine.txt'] }], refused: [], notFound: [] });

    expect(await commands.restoreFromManifest(['ModA'], instanceOf())).toEqual({
      applied: true, landed: [],
      refused: [{ item: 'ModA', reason: "'ModA' was not finished: 'mine.txt' could not be moved to the trash: the trash is full. Restoring it again finishes it." }],
    });
  });

  it('writes each landed mod\'s metadata as its manifest says, through the Instance adapter, after its files no line names went to the trash', async () => {
    const { commands, client, adapter } = commandsOver();
    const metadata = { version: '1.0', installationFiles: [{ name: 'ModA-1.0.7z', source: 'nexus:fallout4:1' }] };
    client.setCommandResult('restoreFromManifest', { landed: [{ mod: 'ModA', written: [], namedByNoLine: ['mine.txt'], metadata }], refused: [], notFound: [] });

    await commands.restoreFromManifest(['ModA'], instanceOf());

    expect(adapter.calls).toEqual([
      { verb: 'trashModFile', mod: 'ModA', relativePath: 'mine.txt' }, { verb: 'writeModMetadata', mod: 'ModA', metadata },
    ]);
  });

  it('writes the metadata of a mod the second call landed, and of no mod that was skipped', async () => {
    const { commands, client, adapter } = commandsOver({ gameFiles: [VANILLA] });
    const metadata = { version: '2.0', installationFiles: [] };
    client.setCommandHandler('restoreFromManifest', (_mods, facts) => Promise.resolve(facts.gameFiles.length === 0
      ? { landed: [], refused: [{ item: 'ModA', reason: 'missing' }, { item: 'ModB', reason: 'no provider' }], notFound: [{ mod: 'ModA', gameFiles: ['Game.esm'], installationFiles: [] }] }
      : { landed: [{ mod: 'ModA', written: [], namedByNoLine: [], metadata }], refused: [], notFound: [] }));

    await commands.restoreFromManifest(['ModA', 'ModB'], instanceOf());

    expect(adapter.calls).toEqual([{ verb: 'writeModMetadata', mod: 'ModA', metadata }]);
  });

  it('answers a mod whose metadata could not be written as not finished, naming why', async () => {
    const { commands, client } = commandsOver({ refusals: refusing('writeModMetadata', 'its source names the Nexus game \'x\'') });
    client.setCommandResult('restoreFromManifest', {
      landed: [{ mod: 'ModA', written: [], namedByNoLine: [], metadata: { version: '1', installationFiles: [] } }], refused: [], notFound: [],
    });

    expect(await commands.restoreFromManifest(['ModA'], instanceOf())).toEqual({
      applied: true, landed: [],
      refused: [{ item: 'ModA', reason: "'ModA' was not finished: its metadata could not be written: its source names the Nexus game 'x'. Restoring it again finishes it." }],
    });
  });

  it('finds no file by the metadata it writes', async () => {
    const { commands, client } = commandsOver({
      metadata: new Map([['ModA', { version: '1.0', installationFiles: [{ name: 'ModA-1.0.7z', source: 'nexus:fallout4:1' }] }]]),
      downloads: new Map([['ModA-1.0.7z', { kind: 'read', answer: INSTALLED }]]),
    });
    client.setCommandResult('restoreFromManifest', RESTORED);

    await commands.restoreFromManifest(['ModA'], instanceOf());

    expect(client.calls.map((call) => call.args[0])).toMatchObject([[{ installationFiles: [] }]]);
  });

  it('refuses the whole gesture when the game folder is not found, because a game file cannot be matched', async () => {
    const { commands, client } = commandsOver();

    const outcome = await commands.restoreFromManifest(['ModA'], instanceOf(GAME_FOLDER_NOT_FOUND));

    expect([client.calls, outcome]).toEqual([[], { applied: false, refusal: 'Could not restore from manifest: the game folder was not found.', unfinished: [] }]);
  });
});

describe('modlistSourceCommands what restore destroys', () => {
  const DESTROYS = [{ mod: 'ModA', differing: ['a.nif'], namedByNoLine: ['mine.txt'], metadataDiffers: false }];

  it('asks mEdit with each mod\'s folder, the files the repository commits itself and the metadata the mod manager holds of it, and the stat cache\'s folder, and answers its listing', async () => {
    const metadata = { version: '1.0', installationFiles: [{ name: 'ModA-1.0.7z', source: 'nexus:fallout4:1' }] };
    const { commands, client } = commandsOver({ metadata: new Map([['ModA', metadata]]) });
    client.setQueryAnswer('getWhatRestoreDestroys', { destroys: DESTROYS, refused: [{ item: 'ModB', reason: "'ModB' was skipped: a file could not be read" }], manifests: [] });

    const listing = await commands.whatRestoreDestroys(['ModA']);

    expect([client.calls, listing]).toEqual([
      [{ method: 'getWhatRestoreDestroys', args: [[{ name: 'ModA', folder: '/mods/ModA', metadataFiles: ['meta.ini'], metadata }], '/instance/stat-cache'] }],
      { destroys: DESTROYS, refused: [{ item: 'ModB', reason: "'ModB' was skipped: a file could not be read" }] },
    ]);
  });

  it('asks nothing of a mod whose name gives it no folder, which restore refuses', async () => {
    const client = new InMemoryMEditClient();
    const commands = modlistSourceCommands({
      client, adapter: { ...fakeInstanceAdapter().adapter, modFolderPath: () => Promise.resolve(undefined) }, instanceRoot: '/instance',
      makeRepository: () => Promise.resolve(), trash: () => Promise.resolve(),
    });

    expect([await commands.whatRestoreDestroys(['ModA']), client.calls]).toEqual([{ destroys: [], refused: [] }, []]);
  });

  it('refuses a mod whose metadata cannot be read, naming why, and asks mEdit about the rest', async () => {
    const { commands, client } = commandsOver({ unreadableMetadata: new Map([['ModA', 'EISDIR: meta.ini']]) });
    client.setQueryAnswer('getWhatRestoreDestroys', { destroys: [], refused: [], manifests: [] });

    const listing = await commands.whatRestoreDestroys(['ModA', 'ModB']);

    expect(sentNamesOf(client.calls[0]?.args[0])).toEqual(['ModB']);
    expect(listing).toEqual({ destroys: [], refused: [{ item: 'ModA', reason: "'ModA' was skipped: its metadata could not be read: EISDIR: meta.ini." }] });
  });

  it('skips a mod whose manifest says metadata the mod manager cannot hold, naming why, and does not list it as destroying', async () => {
    const { commands, client } = commandsOver({ unwritableMetadata: new Map([['ModA', "its source names the Nexus game 'x', which Modbench has no game for"]]) });
    const manifest = { version: '1', installationFiles: [{ name: 'A.7z', source: 'nexus:x:1' }] };
    client.setQueryAnswer('getWhatRestoreDestroys', {
      destroys: [{ mod: 'ModA', differing: [], namedByNoLine: [], metadataDiffers: true }, { mod: 'ModB', differing: ['b.nif'], namedByNoLine: [], metadataDiffers: false }],
      refused: [], manifests: [{ mod: 'ModA', metadata: manifest }, { mod: 'ModB', metadata: { installationFiles: [] } }],
    });

    const listing = await commands.whatRestoreDestroys(['ModA', 'ModB']);

    expect(listing).toEqual({
      destroys: [{ mod: 'ModB', differing: ['b.nif'], namedByNoLine: [], metadataDiffers: false }],
      refused: [{ item: 'ModA', reason: "'ModA' was skipped: its source names the Nexus game 'x', which Modbench has no game for." }],
    });
  });

  it('refuses with mEdit\'s reason when it cannot answer', async () => {
    const { commands, client } = commandsOver();
    client.setQueryFailure('getWhatRestoreDestroys', { failed: 'unreachable' });

    expect(await commands.whatRestoreDestroys(['ModA'])).toEqual({ refusal: 'Could not ask what restore from manifest destroys: mEdit could not be reached.' });
  });
});

describe('modlistSourceCommands mod status', () => {
  const STATUS = [{ mod: 'ModA', noManifest: true, differing: [], namedByNoLine: [], gone: [], noProvider: [], metadataDiffers: false }];

  it('asks mEdit for each mod\'s status by its folder, with the files the repository commits, the metadata the mod manager holds and the stat cache', async () => {
    const { commands, client } = commandsOver({ metadata: new Map([['ModA', { version: '1.2.3', installationFiles: [{ name: 'A.7z', source: 'nexus:fallout4:1' }] }]]) });
    client.setQueryAnswer('getModStatus', STATUS);

    const answer = await commands.modStatus(['ModA']);

    expect([client.calls, answer]).toEqual([
      [{
        method: 'getModStatus',
        args: [[{
          name: 'ModA', folder: '/mods/ModA', metadataFiles: ['meta.ini'],
          metadata: { version: '1.2.3', installationFiles: [{ name: 'A.7z', source: 'nexus:fallout4:1' }] },
        }], '/instance/stat-cache'],
      }], STATUS,
    ]);
  });

  it('says why a mod\'s metadata could not be read, and sends none of it', async () => {
    const { commands, client } = commandsOver({ unreadableMetadata: new Map([['ModA', 'EACCES']]) });
    client.setQueryAnswer('getModStatus', STATUS);

    await commands.modStatus(['ModA']);

    expect(client.calls).toEqual([{
      method: 'getModStatus',
      args: [[{ name: 'ModA', folder: '/mods/ModA', metadataFiles: ['meta.ini'], metadataUnreadable: 'EACCES' }], '/instance/stat-cache'],
    }]);
  });
});
