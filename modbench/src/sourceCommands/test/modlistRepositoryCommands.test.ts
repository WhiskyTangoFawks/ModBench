import { describe, it, expect } from 'vitest';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { FileRead, GameFolder, ModFolder, InstallationFile, InstanceAdapter, OriginFile, OriginFiles } from '../../instanceAdapter/instanceAdapter';
import { fakeInstanceAdapter, fileIn, modFoldersOf, readingFixture, refusing, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { modlistRepositoryCommands } from '../modlistRepositoryCommands';
import { archiveVariants } from '../sourceCommands';

const INSTALLED: InstallationFile = { path: '/downloads/ModA-1.0.7z', size: 10, hash: 'H', entries: [{ path: 'textures/a.dds', hash: 'E' }] };

const recording = (file: InstallationFile): FileRead<InstallationFile> => ({ kind: 'read', answer: file });
const FOUND: GameFolder = { kind: 'found', root: '/game', dataFolder: '/game/Data' };
const NOT_FOUND: GameFolder = { kind: 'notFound', looked: [], setting: 'modbench.gameDirectory' };
const instanceOf = (sourceDirs: ReadonlyMap<string, string> = new Map(), gameFolder: GameFolder = FOUND, modFolders?: readonly ModFolder[]) =>
  ({ gameFolder, gameName: 'Fallout 4', gameRelease: 'Fallout4', modFolders, paths: { sourceDirs } });
const GAME_FOLDER = { name: 'Fallout4', dataFolder: '/game/Data', files: [] };
const filesIn = (filesByMod: Record<string, readonly OriginFile[]>): ReadonlyMap<string, OriginFiles> =>
  new Map(Object.entries(filesByMod).map(([mod, files]) => [mod, { origin: mod, folder: `/mods/${mod}`, files, folders: [], notes: [] }]));

const sentNamesOf = (mods: unknown): string[] => (Array.isArray(mods) ? mods.map((mod: { name: string }) => mod.name) : []);

function commandsOver(answers: InstanceAnswers = {}, client = new InMemoryMEditClient(), filesByMod: Record<string, readonly OriginFile[]> = {}) {
  const adapter = fakeInstanceAdapter(readingFixture({ modFiles: filesIn(filesByMod) }), answers);
  const repositories: string[] = [];
  const commands = modlistRepositoryCommands({
    client, adapter: adapter.adapter, instanceRoot: '/instance',
    makeRepository: () => { repositories.push('made'); return Promise.resolve(); }, trash: () => Promise.resolve(),
  });
  return { commands, client, adapter, repositories };
}

describe('modlistRepositoryCommands git init', () => {
  it('writes the ignore list, makes the instance folder a repository, then makes it refuse a push of a pin its remote lacks', async () => {
    const { commands, adapter, repositories } = commandsOver();

    const result = await commands.gitInit({ holdsRepository: false });

    expect([result.applied, adapter.calls, repositories]).toEqual([true, [{ verb: 'checkPushRefusalFree' }, { verb: 'writeIgnoreList' }, { verb: 'refuseUnpublishedPins' }], ['made']]);
  });

  it('refuses an instance folder that already holds a repository, naming it, and changes nothing', async () => {
    const { commands, adapter, repositories } = commandsOver();

    const result = await commands.gitInit({ holdsRepository: true });

    expect([result, repositories, adapter.calls]).toEqual([{ applied: false, refusal: '/instance already holds a repository.' }, [], []]);
  });

  it('refuses a repository on disk that its last reading did not hold, and changes nothing', async () => {
    const { commands, adapter, repositories } = commandsOver({ repositoryOnDisk: true });

    const result = await commands.gitInit({ holdsRepository: false });

    expect([result, repositories, adapter.calls]).toEqual([{ applied: false, refusal: '/instance already holds a repository.' }, [], []]);
  });

  it('makes no repository when the ignore list could not be written, and says why', async () => {
    const { commands, repositories } = commandsOver({ refusals: refusing('writeIgnoreList', '/instance/.gitignore already exists') });

    expect([await commands.gitInit({ holdsRepository: false }), repositories]).toEqual([{ applied: false, refusal: '/instance/.gitignore already exists' }, []]);
  });

  it('refuses before it writes anything when the push refusal has no free place, naming why', async () => {
    const { commands, adapter, repositories } = commandsOver({ refusals: refusing('checkPushRefusalFree', '/instance/.git/hooks/pre-push already exists') });

    expect([await commands.gitInit({ holdsRepository: false }), repositories, adapter.calls.map(({ verb }) => verb)]).toEqual([
      { applied: false, refusal: '/instance/.git/hooks/pre-push already exists' }, [], ['checkPushRefusalFree'],
    ]);
  });

  it('takes back the repository and the ignore list it made when the push refusal could not be written, naming why', async () => {
    const { commands, adapter, repositories } = commandsOver({ refusals: refusing('refuseUnpublishedPins', '/instance/.git/hooks/pre-push already exists') });

    expect([await commands.gitInit({ holdsRepository: false }), repositories, adapter.calls.map(({ verb }) => verb)]).toEqual([
      { applied: false, refusal: '/instance/.git/hooks/pre-push already exists' },
      ['made'], ['checkPushRefusalFree', 'writeIgnoreList', 'refuseUnpublishedPins', 'removeRepository', 'removeIgnoreList'],
    ]);
  });

  it('names the repository that remains when it could not be taken back', async () => {
    const { commands } = commandsOver({
      refusals: (call) => ({ refuseUnpublishedPins: 'a hook is there', removeRepository: 'read-only folder' })[call.verb as string],
    });

    expect(await commands.gitInit({ holdsRepository: false })).toEqual({
      applied: false, refusal: 'a hook is there; the repository it made remains: read-only folder',
    });
  });

  it('takes back the ignore list it wrote when the repository could not be made, leaving nothing behind', async () => {
    const adapter = fakeInstanceAdapter();
    const commands = modlistRepositoryCommands({
      client: new InMemoryMEditClient(), adapter: adapter.adapter, instanceRoot: '/instance',
      makeRepository: () => Promise.reject(new Error('git is not available')), trash: () => Promise.resolve(),
    });

    const result = await commands.gitInit({ holdsRepository: false });

    expect([result, adapter.calls]).toEqual([
      { applied: false, refusal: 'git is not available' }, [{ verb: 'checkPushRefusalFree' }, { verb: 'writeIgnoreList' }, { verb: 'removeIgnoreList' }],
    ]);
  });

  it('names the ignore list that remains when it could not be taken back', async () => {
    const adapter = fakeInstanceAdapter(readingFixture(), { refusals: refusing('removeIgnoreList', 'read-only folder') });
    const commands = modlistRepositoryCommands({
      client: new InMemoryMEditClient(), adapter: adapter.adapter, instanceRoot: '/instance',
      makeRepository: () => Promise.reject(new Error('git is not available')), trash: () => Promise.resolve(),
    });

    expect(await commands.gitInit({ holdsRepository: false })).toEqual({
      applied: false, refusal: 'git is not available; the ignore list it wrote remains: read-only folder',
    });
  });
});

describe('modlistRepositoryCommands update manifest', () => {
  const UPDATED = { landed: [{ mod: 'ModA', manifestWritten: true, notInPackage: [] }], refused: [] };

  it('hands mEdit each mod with its folder, its installation files, its metadata files and whether it is a source mod, and the stat cache\'s folder', async () => {
    const { commands, client } = commandsOver({
      installations: new Map([['ModA', recording(INSTALLED)]]),
      metadata: new Map([['ModA', { version: '1.2.3' }]]),
    }, new InMemoryMEditClient(), { ModA: [fileIn('/mods/ModA', 'game.ESM')], ModB: [fileIn('/mods/ModB', 'a.nif')] });
    client.setCommandResult('updateManifest', UPDATED);

    await commands.updateManifest(['ModA', 'ModB'], instanceOf(new Map([['ModB', '/source/Old ModB']])));

    expect(client.calls).toEqual([{
      method: 'updateManifest',
      args: [
        [
          { name: 'ModA', folder: '/mods/ModA', installationFile: INSTALLED, metadataFiles: ['meta.ini'], isSourceMod: false, version: '1.2.3' },
          { name: 'ModB', folder: '/mods/ModB', metadataFiles: ['meta.ini'], isSourceMod: true },
        ],
        { statCache: '/instance/stat-cache', gameFolder: GAME_FOLDER },
        { onProgress: expect.any(Function) as unknown, signal: undefined },
      ],
    }]);
  });

  it('makes each source mod with a remote a submodule once mEdit has answered, and names a source mod that is not one', async () => {
    const { commands, client, adapter } = commandsOver({ submodules: { notes: [{ mod: 'ModA', note: 'it has a remote but no branch checked out' }], other: ['source/Odd is not a source mod'] } });
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModA'], instanceOf());

    expect([adapter.calls, outcome]).toMatchObject([[{ verb: 'writeSubmodules' }], { applied: true, notes: [{ mod: 'ModA', note: 'it has a remote but no branch checked out' }], submoduleNotes: ['source/Odd is not a source mod'] }]);
  });

  it('makes no submodule when mEdit refuses the gesture', async () => {
    const { commands, client, adapter } = commandsOver();
    client.setCommandResult('updateManifest', { refused: true, message: 'mEdit is not running.' });

    await commands.updateManifest(['ModA'], instanceOf());

    expect(adapter.calls).toEqual([]);
  });

  it('names the failure to write the submodules beside the manifests that landed', async () => {
    const { commands, client } = commandsOver({ refusals: refusing('writeSubmodules', 'git is not available') });
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModA'], instanceOf());

    expect(outcome).toMatchObject({ applied: true, landed: UPDATED.landed, notes: [], submoduleNotes: ['git is not available'] });
  });

  it('refuses a mod whose metadata cannot be read, naming why, and updates the rest', async () => {
    const { commands, client } = commandsOver({ unreadableMetadata: new Map([['ModA', 'EISDIR: meta.ini']]) });
    client.setCommandResult('updateManifest', { landed: [{ mod: 'ModB', manifestWritten: true, notInPackage: [] }], refused: [] });

    const outcome = await commands.updateManifest(['ModA', 'ModB'], instanceOf());

    expect(client.calls.map((call) => sentNamesOf(call.args[0]))).toEqual([['ModB']]);
    expect(outcome).toMatchObject({ applied: true, refused: [{ item: 'ModA', reason: 'its metadata could not be read: EISDIR: meta.ini' }] });
  });

  it('hands mEdit the game files a mod with no installation file takes, once for every mod that takes them, and none for a mod with an installation file', async () => {
    const taken = (path: string): FileRead<{ gameFiles: { path: string; hash: string }[]; notes: string[] }> =>
      ({ kind: 'read', answer: { gameFiles: [{ path, hash: `#${path}` }], notes: [] } });
    const { commands, client } = commandsOver({
      installations: new Map([['ModA', recording(INSTALLED)]]),
      gameFilesTaken: new Map([['ModA', taken('Ignored.nif')], ['ModB', taken('Meshes/B.nif')], ['ModC', taken('meshes/b.nif')]]),
    });
    client.setCommandResult('updateManifest', UPDATED);

    await commands.updateManifest(['ModA', 'ModB', 'ModC'], instanceOf());

    expect(client.calls[0]?.args[1]).toEqual({
      statCache: '/instance/stat-cache', gameFolder: { ...GAME_FOLDER, files: [{ path: 'meshes/b.nif', hash: '#meshes/b.nif' }] },
    });
  });

  it('names a mod with no installation file when the game folder was not found, and sends no game folder', async () => {
    const { commands, client } = commandsOver({ installations: new Map([['ModA', recording(INSTALLED)]]) });
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModA', 'ModB'], instanceOf(new Map(), NOT_FOUND));

    expect(client.calls[0]?.args[1]).toEqual({ statCache: '/instance/stat-cache' });
    expect(outcome).toMatchObject({ notes: [{ mod: 'ModB', note: expect.stringContaining('the game folder was not found') as unknown }] });
  });

  it('hands no game files for a source mod or a separator, and notes neither when the game folder was not found', async () => {
    const unreadable: FileRead<{ gameFiles: []; notes: [] }> = { kind: 'unreadable', reason: 'it was asked' };
    const { commands, client } = commandsOver({ gameFilesTaken: new Map([['Source', unreadable], ['Group_separator', unreadable]]) });
    client.setCommandResult('updateManifest', UPDATED);
    const folders = modFoldersOf('ModA', 'Source', { kind: 'separator', name: 'Group', modName: 'Group_separator' });
    const found = instanceOf(new Map([['Source', '/source/Source']]), FOUND, folders.all);

    const asked = await commands.updateManifest(['ModA', 'Source', 'Group_separator'], found);
    const outcome = await commands.updateManifest(['ModA', 'Source', 'Group_separator'], { ...found, gameFolder: NOT_FOUND });

    expect(asked).toMatchObject({ refused: [] });
    expect(outcome).toMatchObject({ notes: [{ mod: 'ModA' }] });
    expect(outcome.applied && outcome.notes).toHaveLength(1);
  });

  it('names the game folder by the game\'s release, and hands none for a game the tables hold no release for', async () => {
    const { commands, client } = commandsOver();
    client.setCommandResult('updateManifest', UPDATED);

    await commands.updateManifest(['ModA'], { ...instanceOf(), gameRelease: undefined });

    expect(client.calls[0]?.args[1]).toEqual({ statCache: '/instance/stat-cache' });
  });

  it('names a mod with no installation file, when the game folder was found for a game the tables hold no release for, with that reason', async () => {
    const { commands, client } = commandsOver();
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModA'], { ...instanceOf(), gameRelease: undefined });

    expect(outcome).toMatchObject({
      notes: [{ mod: 'ModA', note: "Modbench knows no release of the game 'Fallout 4', so its manifest cannot name the game folder as its package" }],
    });
  });

  it('refuses a mod whose game files the Instance adapter could not read, naming why, and updates the rest', async () => {
    const { commands, client } = commandsOver({ gameFilesTaken: new Map([['ModA', { kind: 'unreadable', reason: 'EACCES' }]]) });
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModA', 'ModB'], instanceOf());

    expect(sentNamesOf(client.calls[0]?.args[0])).toEqual(['ModB']);
    expect(outcome).toMatchObject({ refused: [{ item: 'ModA', reason: 'EACCES' }] });
  });

  it('names a mod whose installation file comes from a game without a Nexus domain, and sends the file without that fact', async () => {
    const { commands, client } = commandsOver({ installations: new Map([['ModA', recording({ ...INSTALLED, unpagedGame: 'EnderalSE' })]]) });
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModA'], instanceOf());

    expect(outcome).toMatchObject({ notes: [{ mod: 'ModA', note: expect.stringContaining("its installation file comes from 'EnderalSE'") as unknown }] });
    expect(client.calls[0]?.args[0]).toEqual([expect.objectContaining({ installationFile: INSTALLED })]);
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

  it('keeps its own phase when the wire progress carries a null phase', async () => {
    const { commands, client } = commandsOver();
    client.setCommandHandler('updateManifest', (_mods, _facts, options) => {
      options?.onProgress?.({ mod: 'ModA', modsDone: 0, modsTotal: 1, phase: null });
      return Promise.resolve(UPDATED);
    });
    const heard: unknown[] = [];

    await commands.updateManifest(['ModA'], instanceOf(), { onProgress: (status) => heard.push(status) });

    expect(heard).toContainEqual({ phase: 'Updating', mod: 'ModA', modsDone: 0, modsTotal: 1 });
  });

  describe('refuses a mod, naming why, and updates the rest', () => {
    const adapterOf = fakeInstanceAdapter().adapter;
    const refusedFor: [string, Partial<InstanceAdapter>, string][] = [
      ['its name gives it no folder', { modFolderPath: (mod) => Promise.resolve(mod === 'ModA' ? undefined : `/mods/${mod}`) }, 'its name gives it no folder'],
      ['its installation files cannot be read', {
        installationFile: (mod) => Promise.resolve(mod === 'ModA' ? { kind: 'unreadable', reason: 'its installation file is not indexed' } : { kind: 'read', answer: undefined }),
      }, 'its installation file is not indexed'],
    ];

    it.each(refusedFor)('when %s', async (_cause, override, reason) => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('updateManifest', UPDATED);
      const commands = modlistRepositoryCommands({
        client, adapter: { ...adapterOf, ...override }, instanceRoot: '/instance', makeRepository: () => Promise.resolve(), trash: () => Promise.resolve(),
      });

      const outcome = await commands.updateManifest(['ModA', 'ModB'], instanceOf());

      expect(client.calls.map((call) => sentNamesOf(call.args[0]))).toEqual([['ModB']]);
      expect(outcome).toEqual({ applied: true, ...UPDATED, refused: [{ item: 'ModA', reason }], notes: [], submoduleNotes: [] });
    });
  });

  it('does not call mEdit when no mod can be sent', async () => {
    const { commands, client } = commandsOver({ installations: new Map([['ModA', { kind: 'unreadable', reason: 'not indexed' }]]) });

    const outcome = await commands.updateManifest(['ModA'], instanceOf());

    expect([client.calls, outcome]).toEqual([[], { applied: true, landed: [], refused: [{ item: 'ModA', reason: 'not indexed' }], notes: [], submoduleNotes: [] }]);
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

  it('reads no further mod, and hands mEdit none, once its signal aborts while it reads', async () => {
    const cancel = new AbortController();
    const { commands, client } = commandsOver();
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModA', 'ModB'], instanceOf(), {
      signal: cancel.signal, onProgress: (status) => { if (status.phase === 'ReadingFiles') cancel.abort(); },
    });

    expect([client.calls, outcome]).toEqual([[], { applied: true, landed: [], refused: [], notes: [], submoduleNotes: [] }]);
  });

  it('hands mEdit the signal, so a cancel stops it after the mod in hand', async () => {
    const cancel = new AbortController();
    const { commands, client } = commandsOver();
    client.setCommandResult('updateManifest', UPDATED);

    await commands.updateManifest(['ModA'], instanceOf(), { signal: cancel.signal });

    expect(client.calls.map((call) => call.args[2])).toMatchObject([{ signal: cancel.signal }]);
  });
});

describe('modlistRepositoryCommands restore from manifest', () => {
  const RESTORED = { landed: [{ mod: 'ModA', written: ['a.nif'], namedByNoLine: [] }], refused: [], notFound: [] };
  const INSTALLATION_FILE_MISSING = "was skipped: installation file 'ModA-1.0.7z' is missing.";
  const SUBMODULE_MISSING = "was skipped: its submodule 'Mod Source' is missing.";
  const sentNames = (client: InMemoryMEditClient): string[][] => client.calls.map((call) => sentNamesOf(call.args[0]));

  it('hands mEdit each mod with its folder and no installation file or submodule, its metadata files, the stat cache\'s folder and what a build needs', async () => {
    const { commands, client } = commandsOver(
      { installations: new Map([['ModA', recording(INSTALLED)]]), metadata: new Map([['ModA', { version: '1.2.3' }]]) }, new InMemoryMEditClient(), { ModA: [fileIn('/mods/ModA', 'game.esm')] });
    client.setCommandResult('restoreFromManifest', RESTORED);

    await commands.restoreFromManifest(['ModA', 'ModB'], instanceOf(new Map([['ModB', '/source/Old ModB']])));

    expect(client.calls).toEqual([{
      method: 'restoreFromManifest',
      args: [
        [
          { name: 'ModA', folder: '/mods/ModA', metadataFiles: ['meta.ini'] },
          { name: 'ModB', folder: '/mods/ModB', metadataFiles: ['meta.ini'] },
        ],
        { statCache: '/instance/stat-cache', excludedSuffix: '.excluded', archives: archiveVariants('Fallout4'), gameFolder: GAME_FOLDER },
        { onProgress: expect.any(Function) as unknown, signal: undefined },
      ],
    }]);
  });

  it('sends a mod skipped for game files the call did not hand again, with the game files of those paths, and answers both sends as one', async () => {
    const { commands, client } = commandsOver({ gameFiles: new Map([['meshes/a.nif', { path: 'Meshes/A.nif', hash: '#a' }]]) });
    client.setCommandHandler('restoreFromManifest', (_mods, facts) => Promise.resolve(facts.gameFolder?.files.length
      ? RESTORED
      : { landed: [], refused: [{ item: 'ModA', reason: 'was skipped: game file is missing.' }], notFound: [{ mod: 'ModA', gameFiles: ['meshes/a.nif'] }] }));

    const outcome = await commands.restoreFromManifest(['ModA'], instanceOf());

    expect(client.calls.map((call) => call.args[1])).toMatchObject([
      { gameFolder: GAME_FOLDER }, { gameFolder: { ...GAME_FOLDER, files: [{ path: 'Meshes/A.nif', hash: '#a' }] } }]);
    expect(outcome).toEqual({ applied: true, landed: RESTORED.landed, refused: [] });
  });

  it('says why beside a mod still skipped for game files when the game folder was not found', async () => {
    const { commands, client } = commandsOver();
    client.setCommandResult('restoreFromManifest', {
      landed: [], refused: [{ item: 'ModA', reason: 'was skipped: game file is missing.' }], notFound: [{ mod: 'ModA', gameFiles: ['a.nif'] }],
    });

    const outcome = await commands.restoreFromManifest(['ModA'], instanceOf(new Map(), NOT_FOUND));

    expect(outcome).toMatchObject({ refused: [{ item: 'ModA', reason: 'was skipped: game file is missing. The game folder was not found.' }] });
  });

  it('says why beside a mod still skipped for game files when the game folder was found for a game the tables hold no release for', async () => {
    const { commands, client } = commandsOver();
    client.setCommandResult('restoreFromManifest', {
      landed: [], refused: [{ item: 'ModA', reason: 'was skipped: game file is missing.' }], notFound: [{ mod: 'ModA', gameFiles: ['a.nif'] }],
    });

    const outcome = await commands.restoreFromManifest(['ModA'], { ...instanceOf(), gameRelease: undefined });

    expect(outcome).toMatchObject({ refused: [{ item: 'ModA', reason: "was skipped: game file is missing. Modbench knows no release of the game 'Fallout 4'." }] });
  });

  it('sends a mod skipped for a submodule the call did not hand again, with where git checks it out, its pin and its branch, and answers both sends as one', async () => {
    const pinned = { folder: '/instance/source/Mod Source', pin: 'abc123', branch: 'main' };
    const { commands, client } = commandsOver({ pins: new Map([['Mod Source', pinned]]) });
    client.setCommandHandler('restoreFromManifest', (mods) => Promise.resolve(mods[0]?.submodule === undefined
      ? { landed: [], refused: [{ item: 'ModA', reason: SUBMODULE_MISSING }], notFound: [{ mod: 'ModA', submodule: 'Mod Source', gameFiles: [] }] }
      : RESTORED));

    const outcome = await commands.restoreFromManifest(['ModA'], instanceOf());

    expect(client.calls.map((call) => call.args[0])).toMatchObject([[{ name: 'ModA' }], [{ name: 'ModA', submodule: pinned }]]);
    expect(outcome).toEqual({ applied: true, landed: RESTORED.landed, refused: [] });
  });

  it('says why beside a mod still skipped for a submodule the instance repository holds no pin for', async () => {
    const { commands, client } = commandsOver({ pins: new Map([['Mod Source', { lacks: 'the instance repository pins no commit at source/Mod Source' }]]) });
    client.setCommandResult('restoreFromManifest', {
      landed: [], refused: [{ item: 'ModA', reason: SUBMODULE_MISSING }], notFound: [{ mod: 'ModA', submodule: 'Mod Source', gameFiles: [] }],
    });

    const outcome = await commands.restoreFromManifest(['ModA'], instanceOf());

    expect(outcome).toEqual({
      applied: true, landed: [], refused: [{ item: 'ModA', reason: `${SUBMODULE_MISSING} The instance repository pins no commit at source/Mod Source.` }],
    });
  });

  it('makes the instance repository refuse a push of a pin its source mod\'s remote lacks, as git init does, once the mods landed', async () => {
    const { commands, client, adapter } = commandsOver({ repositoryOnDisk: true });
    client.setCommandResult('restoreFromManifest', { landed: [{ mod: 'ModA', written: [], namedByNoLine: ['mine.txt'] }], refused: [], notFound: [] });

    const outcome = await commands.restoreFromManifest(['ModA'], instanceOf());

    expect(adapter.calls.map(({ verb }) => verb)).toEqual(['trashModFile', 'refuseUnpublishedPins']);
    expect(outcome).not.toHaveProperty('pushRefusalNotWritten');
  });

  it('names why the push refusal could not be written beside the mods that landed', async () => {
    const { commands, client } = commandsOver({ repositoryOnDisk: true, refusals: refusing('refuseUnpublishedPins', '/instance/.git/hooks/pre-push is not Modbench\'s') });
    client.setCommandResult('restoreFromManifest', RESTORED);

    expect(await commands.restoreFromManifest(['ModA'], instanceOf())).toEqual({
      applied: true, landed: RESTORED.landed, refused: [], pushRefusalNotWritten: "/instance/.git/hooks/pre-push is not Modbench's",
    });
  });

  it('writes no push refusal in an instance folder that holds no repository', async () => {
    const { commands, client, adapter } = commandsOver({ repositoryOnDisk: false });
    client.setCommandResult('restoreFromManifest', RESTORED);

    await commands.restoreFromManifest(['ModA'], instanceOf());

    expect(adapter.calls).toEqual([]);
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

  it('keeps its own phase when the wire progress carries a null phase', async () => {
    const { commands, client } = commandsOver();
    client.setCommandHandler('restoreFromManifest', (_mods, _facts, options) => {
      options?.onProgress?.({ mod: 'ModA', modsDone: 0, modsTotal: 1, phase: null });
      return Promise.resolve(RESTORED);
    });
    const heard: unknown[] = [];

    await commands.restoreFromManifest(['ModA'], instanceOf(), { onProgress: (status) => heard.push(status) });

    expect(heard).toContainEqual({ phase: 'Restoring', mod: 'ModA', modsDone: 0, modsTotal: 1 });
  });

  it('sends a mod skipped for an installation file the call did not hand again, with the downloaded file of that name, and answers both sends as one', async () => {
    const { commands, client } = commandsOver({ downloads: new Map([['ModA-1.0.7z', { kind: 'read', answer: INSTALLED }]]) });
    client.setCommandHandler('restoreFromManifest', (mods) => Promise.resolve(mods[0]?.installationFile === undefined
      ? { landed: [], refused: [{ item: 'ModA', reason: INSTALLATION_FILE_MISSING }], notFound: [{ mod: 'ModA', installationFile: 'ModA-1.0.7z', gameFiles: [] }] }
      : RESTORED));

    const outcome = await commands.restoreFromManifest(['ModA'], instanceOf());

    expect(client.calls.map((call) => call.args[0])).toMatchObject([[{}], [{ installationFile: INSTALLED }]]);
    expect(outcome).toEqual({ applied: true, landed: RESTORED.landed, refused: [] });
  });

  it('says why beside a mod still skipped for an installation file the Instance adapter could not read', async () => {
    const { commands, client } = commandsOver({ downloads: new Map([['ModA-1.0.7z', { kind: 'unreadable', reason: 'EACCES' }]]) });
    client.setCommandResult('restoreFromManifest', {
      landed: [], refused: [{ item: 'ModA', reason: INSTALLATION_FILE_MISSING }], notFound: [{ mod: 'ModA', installationFile: 'ModA-1.0.7z', gameFiles: [] }],
    });

    const outcome = await commands.restoreFromManifest(['ModA'], instanceOf());

    expect(outcome).toEqual({ applied: true, landed: [], refused: [{ item: 'ModA', reason: `${INSTALLATION_FILE_MISSING} 'ModA-1.0.7z' could not be read: EACCES.` }] });
  });

  it('sends no skipped mod again once its signal aborts, handing mEdit the signal, so a cancel stops after the mod in hand', async () => {
    const cancel = new AbortController();
    const { commands, client } = commandsOver();
    client.setCommandHandler('restoreFromManifest', () => {
      cancel.abort();
      return Promise.resolve({ landed: [], refused: [], notFound: [{ mod: 'ModA', installationFile: 'ModA-1.0.7z', gameFiles: [] }] });
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
        landed: RESTORED.landed, refused: [{ item: 'ModB', reason: "was skipped: installation file 'ModB.7z' is missing." }],
        notFound: [{ mod: 'ModB', installationFile: 'ModB.7z', gameFiles: [] }],
      });
    });

    const outcome = await commands.restoreFromManifest(['ModA', 'ModB', 'ModC'], instanceOf(), { signal: cancel.signal });

    expect(outcome).toEqual({
      applied: true, landed: RESTORED.landed,
      refused: ['ModB', 'ModC'].map((mod) => ({ item: mod, reason: `was not finished: the restore was cancelled. Restoring it again finishes it.` })),
    });
  });

  it('names each mod a cancel stopped before it was read as unfinished', async () => {
    const cancel = new AbortController();
    const { commands } = commandsOver();

    const outcome = await commands.restoreFromManifest(['ModA'], instanceOf(), { signal: cancel.signal, onProgress: () => { cancel.abort(); } });

    expect(outcome).toEqual({
      applied: true, landed: [], refused: [{ item: 'ModA', reason: "was not finished: the restore was cancelled. Restoring it again finishes it." }],
    });
  });

  it('answers the refusal of the user\'s cancel beside what mEdit restored', async () => {
    const { commands, client } = commandsOver();
    client.setCommandResult('restoreFromManifest', { ...RESTORED, cancelRefusal: 'Could not cancel — not running.' });

    expect(await commands.restoreFromManifest(['ModA'], instanceOf())).toMatchObject({ cancelRefusal: 'Could not cancel — not running.' });
  });

  it('answers the refusal of a cancel during the second send beside what both sends restored', async () => {
    const { commands, client } = commandsOver({ downloads: new Map([['ModA-1.0.7z', { kind: 'read', answer: INSTALLED }]]) });
    client.setCommandHandler('restoreFromManifest', (mods) => Promise.resolve(mods[0]?.installationFile === undefined
      ? { landed: [], refused: [], notFound: [{ mod: 'ModA', installationFile: 'ModA-1.0.7z', gameFiles: [] }] }
      : { landed: [{ mod: 'ModA', written: ['a.nif'], namedByNoLine: [] }], refused: [], notFound: [], cancelRefusal: 'Could not cancel — not running.' }));

    expect(await commands.restoreFromManifest(['ModA'], instanceOf())).toMatchObject({ cancelRefusal: 'Could not cancel — not running.' });
  });

  it('refuses a mod the Instance adapter cannot answer, naming why, and restores the rest', async () => {
    const adapter = fakeInstanceAdapter().adapter;
    const client = new InMemoryMEditClient();
    const commands = modlistRepositoryCommands({
      client, adapter: { ...adapter, modFolderPath: (mod) => Promise.resolve(mod === 'ModA' ? undefined : `/mods/${mod}`) },
      instanceRoot: '/instance', makeRepository: () => Promise.resolve(), trash: () => Promise.resolve(),
    });
    client.setCommandResult('restoreFromManifest', { landed: [{ mod: 'ModB', written: [], namedByNoLine: [] }], refused: [], notFound: [] });

    const outcome = await commands.restoreFromManifest(['ModA', 'ModB'], instanceOf());

    expect([sentNames(client), outcome]).toEqual([
      [['ModB']], { applied: true, landed: [{ mod: 'ModB', written: [], namedByNoLine: [] }], refused: [{ item: 'ModA', reason: 'its name gives it no folder' }] },
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
    const { commands, client, adapter } = commandsOver({ downloads: new Map([['ModB.7z', { kind: 'read', answer: INSTALLED }]]) });
    client.setCommandHandler('restoreFromManifest', (mods) => Promise.resolve(mods.length === 2
      ? { landed: [{ mod: 'ModA', written: [], namedByNoLine: ['mine.txt'] }], refused: [], notFound: [{ mod: 'ModB', installationFile: 'ModB.7z', gameFiles: [] }] }
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
      refused: [{ item: 'ModA', reason: "was not finished: 'mine.txt' could not be moved to the trash: the trash is full. Restoring it again finishes it." }],
    });
  });

  it('writes each landed mod\'s metadata as its manifest says, through the Instance adapter, after its files no line names went to the trash', async () => {
    const { commands, client, adapter } = commandsOver();
    const metadata = { version: '1.0', installationFile: { name: 'ModA-1.0.7z', page: 'https://www.nexusmods.com/fallout4/mods/1' } };
    client.setCommandResult('restoreFromManifest', { landed: [{ mod: 'ModA', written: [], namedByNoLine: ['mine.txt'], metadata }], refused: [], notFound: [] });

    await commands.restoreFromManifest(['ModA'], instanceOf());

    expect(adapter.calls).toEqual([
      { verb: 'trashModFile', mod: 'ModA', relativePath: 'mine.txt' }, { verb: 'writeModMetadata', mod: 'ModA', metadata },
    ]);
  });

  it('writes the metadata of a mod the second call landed, and of no mod that was skipped', async () => {
    const { commands, client, adapter } = commandsOver({ downloads: new Map([['ModA-1.0.7z', { kind: 'read', answer: INSTALLED }]]) });
    const metadata = { version: '2.0' };
    client.setCommandHandler('restoreFromManifest', (mods) => Promise.resolve(mods.length === 2
      ? { landed: [], refused: [{ item: 'ModA', reason: 'missing' }, { item: 'ModB', reason: "its package does not hold 'b.nif'" }], notFound: [{ mod: 'ModA', installationFile: 'ModA-1.0.7z', gameFiles: [] }] }
      : { landed: [{ mod: 'ModA', written: [], namedByNoLine: [], metadata }], refused: [], notFound: [] }));

    await commands.restoreFromManifest(['ModA', 'ModB'], instanceOf());

    expect(adapter.calls).toEqual([{ verb: 'writeModMetadata', mod: 'ModA', metadata }]);
  });

  it('answers a mod whose metadata could not be written as not finished, naming why', async () => {
    const { commands, client } = commandsOver({ refusals: refusing('writeModMetadata', 'its source names the Nexus game \'x\'') });
    client.setCommandResult('restoreFromManifest', {
      landed: [{ mod: 'ModA', written: [], namedByNoLine: [], metadata: { version: '1' } }], refused: [], notFound: [],
    });

    expect(await commands.restoreFromManifest(['ModA'], instanceOf())).toEqual({
      applied: true, landed: [],
      refused: [{ item: 'ModA', reason: "was not finished: its metadata could not be written: its source names the Nexus game 'x'. Restoring it again finishes it." }],
    });
  });

  it('finds no file by the metadata it writes', async () => {
    const { commands, client } = commandsOver({
      metadata: new Map([['ModA', { version: '1.0', installationFile: { name: 'ModA-1.0.7z', page: 'https://www.nexusmods.com/fallout4/mods/1' } }]]),
      downloads: new Map([['ModA-1.0.7z', { kind: 'read', answer: INSTALLED }]]),
    });
    client.setCommandResult('restoreFromManifest', RESTORED);

    await commands.restoreFromManifest(['ModA'], instanceOf());

    expect(client.calls.map((call) => call.args[0])).toMatchObject([[{}]]);
  });

});

describe('modlistRepositoryCommands what restore destroys', () => {
  const DESTROYS = [{ mod: 'ModA', differing: ['a.nif'], namedByNoLine: ['mine.txt'], metadataDiffers: false }];

  it('asks mEdit with each mod\'s folder, its metadata files and the metadata the mod manager holds of it, and the stat cache\'s folder, and answers its listing', async () => {
    const metadata = { version: '1.0', installationFile: { name: 'ModA-1.0.7z', page: 'https://www.nexusmods.com/fallout4/mods/1' } };
    const { commands, client } = commandsOver({ metadata: new Map([['ModA', metadata]]) });
    client.setQueryAnswer('getWhatRestoreDestroys', { destroys: DESTROYS, refused: [{ item: 'ModB', reason: "was skipped: a file could not be read" }], manifests: [] });

    const listing = await commands.whatRestoreDestroys(['ModA']);

    expect([client.calls, listing]).toEqual([
      [{ method: 'getWhatRestoreDestroys', args: [[{ name: 'ModA', folder: '/mods/ModA', metadataFiles: ['meta.ini'], metadata }], '/instance/stat-cache'] }],
      { destroys: DESTROYS, refused: [{ item: 'ModB', reason: "was skipped: a file could not be read" }] },
    ]);
  });

  it('asks nothing of a mod whose name gives it no folder, which restore refuses', async () => {
    const client = new InMemoryMEditClient();
    const commands = modlistRepositoryCommands({
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
    expect(listing).toEqual({ destroys: [], refused: [{ item: 'ModA', reason: "was skipped: its metadata could not be read: EISDIR: meta.ini." }] });
  });

  it('skips a mod whose manifest says metadata the mod manager cannot hold, naming why, and does not list it as destroying', async () => {
    const { commands, client } = commandsOver({ unwritableMetadata: new Map([['ModA', "its source names the Nexus game 'x', which Modbench has no game for"]]) });
    const manifest = { version: '1', installationFile: { name: 'A.7z', page: 'https://www.nexusmods.com/x/mods/1' } };
    client.setQueryAnswer('getWhatRestoreDestroys', {
      destroys: [{ mod: 'ModA', differing: [], namedByNoLine: [], metadataDiffers: true }, { mod: 'ModB', differing: ['b.nif'], namedByNoLine: [], metadataDiffers: false }],
      refused: [], manifests: [{ mod: 'ModA', metadata: manifest }, { mod: 'ModB', metadata: {} }],
    });

    const listing = await commands.whatRestoreDestroys(['ModA', 'ModB']);

    expect(listing).toEqual({
      destroys: [{ mod: 'ModB', differing: ['b.nif'], namedByNoLine: [], metadataDiffers: false }],
      refused: [{ item: 'ModA', reason: "was skipped: its source names the Nexus game 'x', which Modbench has no game for." }],
    });
  });

  it('refuses with mEdit\'s reason when it cannot answer', async () => {
    const { commands, client } = commandsOver();
    client.setQueryFailure('getWhatRestoreDestroys', { failed: 'unreachable' });

    expect(await commands.whatRestoreDestroys(['ModA'])).toEqual({ refusal: 'Could not ask what restore from manifest destroys: mEdit could not be reached.' });
  });
});

describe('modlistRepositoryCommands mod status', () => {
  const STATUS = [{ mod: 'ModA', noManifest: true, differing: [], namedByNoLine: [], gone: [], notInPackage: [], metadataDiffers: false, noHost: false }];

  it('asks mEdit for each mod\'s status by its folder, with its metadata files, the metadata the mod manager holds and the stat cache', async () => {
    const { commands, client } = commandsOver({ metadata: new Map([['ModA', { version: '1.2.3', installationFile: { name: 'A.7z', page: 'https://www.nexusmods.com/fallout4/mods/1' } }]]) });
    client.setQueryAnswer('getModStatus', STATUS);

    const answer = await commands.modStatus(['ModA']);

    expect([client.calls, answer]).toEqual([
      [{
        method: 'getModStatus',
        args: [[{
          name: 'ModA', folder: '/mods/ModA', metadataFiles: ['meta.ini'],
          metadata: { version: '1.2.3', installationFile: { name: 'A.7z', page: 'https://www.nexusmods.com/fallout4/mods/1' } },
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
