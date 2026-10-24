import { describe, it, expect } from 'vitest';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { ManifestInstallationFile } from '../../client';
import type { FileRead, GameFolder, InstallationFile, InstanceAdapter, InstanceReading, ModFolders, OriginFile, OriginFiles } from '../../instanceAdapter/instanceAdapter';
import { fakeInstanceAdapter, fileIn, modFoldersOf, readingFixture, refusing, sourceModsOf, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { modlistRepositoryCommands } from '../modlistRepositoryCommands';
import { archiveVariants } from '../sourceCommands';
import type { HostGit } from '../../ports/repository';
import { hostGitFailingToActivate, hostGitRecordingInits } from './hostGitDouble';
import { GAME_FOLDER_NOT_FOUND } from '../../test/mo2/gameFolderNotFound';
import { restoredMod } from '../../test/restoredMod';
import { answeringFrom, FILE_78, nexusAnswering, nexusServing, servingFile78 } from '../../nexus/test/nexusDouble';
import type { Nexus } from '../../nexus/nexus';


const INSTALLED: InstallationFile = { path: '/downloads/ModA-1.0.7z', size: 10, hash: 'H', entries: [{ path: 'textures/a.dds', hash: 'E' }] };

const recording = (file: InstallationFile): FileRead<InstallationFile> => ({ kind: 'read', answer: file });
const FOUND: GameFolder = { kind: 'found', root: '/game', dataFolder: '/game/Data' };
const readingOf = (sourceFolders: Record<string, string> = {}, gameFolder: GameFolder = FOUND, modFolders?: ModFolders): Partial<InstanceReading> =>
  ({ gameFolder, sourceMods: sourceModsOf(sourceFolders), modFolders });
const GAME_FOLDER = { name: 'Fallout4', dataFolder: '/game/Data', files: [] };
const filesIn = (filesByMod: Record<string, readonly OriginFile[]>): ReadonlyMap<string, OriginFiles> =>
  new Map(Object.entries(filesByMod).map(([mod, files]) => [mod, { origin: mod, folder: `/mods/${mod}`, files, folders: [], notes: [] }]));

const loggedOutOfNexus = (): Nexus => nexusAnswering(answeringFrom({})).nexus;

const sentNamesOf = (mods: unknown): string[] => (Array.isArray(mods) ? mods.map((mod: { name: string }) => mod.name) : []);

interface Wiring { nexus?: Nexus; hostGit?: HostGit<string>; adapterOver?: Partial<InstanceAdapter> }

function commandsOver(
  answers: InstanceAnswers = {}, client = new InMemoryMEditClient(), filesByMod: Record<string, readonly OriginFile[]> = {}, instance: Partial<InstanceReading> = readingOf(),
  { nexus = loggedOutOfNexus(), hostGit, adapterOver = {} }: Wiring = {},
) {
  const adapter = fakeInstanceAdapter(readingFixture({ modFiles: filesIn(filesByMod), ...instance }), answers);
  const repositories: string[] = [];
  const commands = modlistRepositoryCommands({
    client, adapter: { ...adapter.adapter, ...adapterOver }, nexus, instanceRoot: '/instance',
    hostGit: hostGit ?? hostGitRecordingInits(repositories), trash: () => Promise.resolve(),
  });
  return { commands, client, adapter, repositories };
}

const commandsWired = (wiring: Wiring, answers: InstanceAnswers = {}) => commandsOver(answers, new InMemoryMEditClient(), {}, readingOf(), wiring);

describe('modlistRepositoryCommands git init', () => {
  it('writes the ignore list, makes the instance folder a repository, then makes it refuse a push of a pin its remote lacks and hold paths by path tokens', async () => {
    const { commands, adapter, repositories } = commandsOver();

    const result = await commands.gitInit();

    expect([result.applied, adapter.calls, repositories]).toEqual([
      true, [{ verb: 'checkPushRefusalFree' }, { verb: 'writeIgnoreList' }, { verb: 'refuseUnpublishedPins' }, { verb: 'keepOutOfPublisher' }, { verb: 'writePathTokens' }], ['uri:/instance'],
    ]);
  });

  it('names why a path token stays in the working tree beside the repository it made', async () => {
    const { commands } = commandsOver({ pathTokenLeft: 'ModOrganizer.ini still holds a path token' });

    expect(await commands.gitInit()).toEqual({ applied: true, pathTokensNotWritten: 'ModOrganizer.ini still holds a path token' });
  });

  it('takes back the repository, the ignore list and the publisher\'s ignore list entries it made when the path tokens could not be written, naming why', async () => {
    const { commands, adapter } = commandsOver({ refusals: refusing('writePathTokens', 'could not lock config file .git/config') });

    expect([await commands.gitInit(), adapter.calls.map(({ verb }) => verb)]).toEqual([
      { applied: false, refusal: 'could not lock config file .git/config' },
      ['checkPushRefusalFree', 'writeIgnoreList', 'refuseUnpublishedPins', 'keepOutOfPublisher', 'writePathTokens', 'takeBackKeepOutOfPublisher', 'takeBackPushRefusal', 'removeRepository', 'takeBackIgnoreList'],
    ]);
  });

  describe('on an instance folder that holds a repository', () => {
    it('adds the ignore list, the push check and the path tokens, and makes no repository', async () => {
      const { commands, adapter, repositories } = commandsOver({ repositoryOnDisk: true });

      const result = await commands.gitInit();

      expect([result, repositories, adapter.calls]).toEqual([
        { applied: true }, [], [{ verb: 'writeIgnoreList' }, { verb: 'refuseUnpublishedPins' }, { verb: 'keepOutOfPublisher' }, { verb: 'writePathTokens' }],
      ]);
    });

    it('keeps another pre-push hook, names why the push check is not written, and still writes the path tokens', async () => {
      const { commands, adapter } = commandsOver({
        repositoryOnDisk: true, refusals: refusing('refuseUnpublishedPins', '/instance/.git/hooks/pre-push already exists'),
      });

      expect([await commands.gitInit(), adapter.calls.map(({ verb }) => verb)]).toEqual([
        { applied: true, pushRefusalNotWritten: '/instance/.git/hooks/pre-push already exists' },
        ['writeIgnoreList', 'refuseUnpublishedPins', 'keepOutOfPublisher', 'writePathTokens'],
      ]);
    });

    it('takes back the push check and the ignore list it added, and not the repository, when the path tokens could not be written', async () => {
      const { commands, adapter, repositories } = commandsOver({ repositoryOnDisk: true, refusals: refusing('writePathTokens', 'could not lock config file') });

      expect([await commands.gitInit(), repositories, adapter.calls.map(({ verb }) => verb)]).toEqual([
        { applied: false, refusal: 'could not lock config file' }, [], ['writeIgnoreList', 'refuseUnpublishedPins', 'keepOutOfPublisher', 'writePathTokens', 'takeBackKeepOutOfPublisher', 'takeBackPushRefusal', 'takeBackIgnoreList'],
      ]);
    });
  });

  it('takes back everything before the publisher\'s ignore list when it could not be written', async () => {
    const { commands, repositories, adapter } = commandsOver({ refusals: refusing('keepOutOfPublisher', 'compiler_settings.json cannot be written') });

    expect([await commands.gitInit(), repositories, adapter.calls.map(({ verb }) => verb)]).toEqual([
      { applied: false, refusal: 'compiler_settings.json cannot be written' }, ['uri:/instance'],
      ['checkPushRefusalFree', 'writeIgnoreList', 'refuseUnpublishedPins', 'keepOutOfPublisher', 'takeBackPushRefusal', 'removeRepository', 'takeBackIgnoreList'],
    ]);
  });

  it('refuses before it writes anything when the publisher\'s configuration cannot be read, naming why', async () => {
    const { commands, repositories, adapter } = commandsOver({ unreadablePublisher: 'compiler_settings.json is not JSON' });

    expect([await commands.gitInit(), repositories, adapter.calls]).toEqual([{ applied: false, refusal: 'compiler_settings.json is not JSON' }, [], [{ verb: 'checkPushRefusalFree' }]]);
  });

  it('makes no repository when the ignore list could not be written, and says why', async () => {
    const { commands, repositories } = commandsOver({ refusals: refusing('writeIgnoreList', '/instance/.gitignore already exists') });

    expect([await commands.gitInit(), repositories]).toEqual([{ applied: false, refusal: '/instance/.gitignore already exists' }, []]);
  });

  it('refuses before it writes anything when the push refusal has no free place, naming why', async () => {
    const { commands, adapter, repositories } = commandsOver({ refusals: refusing('checkPushRefusalFree', '/instance/.git/hooks/pre-push already exists') });

    expect([await commands.gitInit(), repositories, adapter.calls.map(({ verb }) => verb)]).toEqual([
      { applied: false, refusal: '/instance/.git/hooks/pre-push already exists' }, [], ['checkPushRefusalFree'],
    ]);
  });

  it('takes back the repository and the ignore list it made when the push refusal could not be written, naming why', async () => {
    const { commands, adapter, repositories } = commandsOver({ refusals: refusing('refuseUnpublishedPins', '/instance/.git/hooks/pre-push already exists') });

    expect([await commands.gitInit(), repositories, adapter.calls.map(({ verb }) => verb)]).toEqual([
      { applied: false, refusal: '/instance/.git/hooks/pre-push already exists' },
      ['uri:/instance'], ['checkPushRefusalFree', 'writeIgnoreList', 'refuseUnpublishedPins', 'removeRepository', 'takeBackIgnoreList'],
    ]);
  });

  it('names the repository that remains when it could not be taken back', async () => {
    const { commands } = commandsOver({
      refusals: (call) => ({ refuseUnpublishedPins: 'a hook is there', removeRepository: 'read-only folder' })[call.verb as string],
    });

    expect(await commands.gitInit()).toEqual({
      applied: false, refusal: 'a hook is there; the repository it made remains: read-only folder',
    });
  });

  it('takes back the ignore list it wrote when the repository could not be made, leaving nothing behind', async () => {
    const { commands, adapter } = commandsWired({ hostGit: hostGitFailingToActivate('git is not available') });

    const result = await commands.gitInit();

    expect([result, adapter.calls]).toEqual([
      { applied: false, refusal: 'git is not available' }, [{ verb: 'checkPushRefusalFree' }, { verb: 'writeIgnoreList' }, { verb: 'takeBackIgnoreList' }],
    ]);
  });

  it('names the ignore list that remains when it could not be taken back', async () => {
    const { commands } = commandsWired({ hostGit: hostGitFailingToActivate('git is not available') }, { refusals: refusing('takeBackIgnoreList', 'read-only folder') });

    expect(await commands.gitInit()).toEqual({
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
    }, new InMemoryMEditClient(), { ModA: [fileIn('/mods/ModA', 'game.ESM')], ModB: [fileIn('/mods/ModB', 'a.nif')] }, readingOf({ ModB: '/source/Old ModB' }));
    client.setCommandResult('updateManifest', UPDATED);

    await commands.updateManifest(['ModA', 'ModB']);

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

    const outcome = await commands.updateManifest(['ModA']);

    expect([adapter.calls, outcome]).toMatchObject([[{ verb: 'writeSubmodules' }, { verb: 'keepOutOfPublisher' }, { verb: 'writePathTokens' }], { applied: true, notes: [{ mod: 'ModA', note: 'it has a remote but no branch checked out' }], repositoryNotes: ['source/Odd is not a source mod'] }]);
  });

  it('reports each path no path token names, naming its file, and why a path token stays', async () => {
    const { commands, client, adapter } = commandsOver({
      pathTokenLeft: 'ModOrganizer.ini still holds a path token', pathsOutsideFolders: [{ file: 'ModOrganizer.ini', path: 'C:/Modding/x.exe' }],
    });
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModA']);

    expect([adapter.calls.map(({ verb }) => verb), outcome]).toMatchObject([['writeSubmodules', 'keepOutOfPublisher', 'writePathTokens'], {
      applied: true, repositoryNotes: ['ModOrganizer.ini still holds a path token', 'ModOrganizer.ini holds a path no path token names: C:/Modding/x.exe'],
    }]);
  });

  it.each([
    ['writing the path tokens', { refusals: refusing('writePathTokens', 'git is not available') }, 'the path tokens could not be written: git is not available'],
    ['reading the paths', { unreadReads: { pathsOutsideFolders: 'git is not available' } },
      "the paths the instance repository's files hold could not be read: git is not available"],
  ])('names the failure of %s beside the manifests that landed', async (_failure, failing: InstanceAnswers, note) => {
    const { commands, client } = commandsOver(failing);
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModA']);

    expect(outcome).toMatchObject({ applied: true, landed: UPDATED.landed, repositoryNotes: [note] });
  });

  it('reports each path no path token names when every mod is refused', async () => {
    const { commands } = commandsOver({
      unreadableMetadata: new Map([['ModA', 'EISDIR: meta.ini']]), pathsOutsideFolders: [{ file: 'ModOrganizer.ini', path: 'C:/Modding/x.exe' }],
    });

    expect(await commands.updateManifest(['ModA'])).toMatchObject({
      applied: true, landed: [], repositoryNotes: ['ModOrganizer.ini holds a path no path token names: C:/Modding/x.exe'],
    });
  });

  it('names the failure to keep Modbench\'s files out of the publisher beside the manifests that landed', async () => {
    const { commands, client } = commandsOver({ refusals: refusing('keepOutOfPublisher', 'compiler_settings.json is not JSON') });
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModA']);

    expect(outcome).toMatchObject({ applied: true, landed: UPDATED.landed, repositoryNotes: ['compiler_settings.json is not JSON'] });
  });

  it('makes no submodule when mEdit refuses the gesture', async () => {
    const { commands, client, adapter } = commandsOver();
    client.setCommandResult('updateManifest', { refused: true, message: 'mEdit is not running.' });

    await commands.updateManifest(['ModA']);

    expect(adapter.calls).toEqual([]);
  });

  it('names the failure to write the submodules beside the manifests that landed', async () => {
    const { commands, client } = commandsOver({ refusals: refusing('writeSubmodules', 'git is not available') });
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModA']);

    expect(outcome).toMatchObject({ applied: true, landed: UPDATED.landed, notes: [], repositoryNotes: ['git is not available'] });
  });

  it('refuses a mod whose metadata cannot be read, naming why, and updates the rest', async () => {
    const { commands, client } = commandsOver({ unreadableMetadata: new Map([['ModA', 'EISDIR: meta.ini']]) });
    client.setCommandResult('updateManifest', { landed: [{ mod: 'ModB', manifestWritten: true, notInPackage: [] }], refused: [] });

    const outcome = await commands.updateManifest(['ModA', 'ModB']);

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

    await commands.updateManifest(['ModA', 'ModB', 'ModC']);

    expect(client.calls[0]?.args[1]).toEqual({
      statCache: '/instance/stat-cache', gameFolder: { ...GAME_FOLDER, files: [{ path: 'meshes/b.nif', hash: '#meshes/b.nif' }] },
    });
  });

  it('names a mod with no installation file when the game folder was not found, and sends no game folder', async () => {
    const { commands, client } = commandsOver({ installations: new Map([['ModA', recording(INSTALLED)]]) }, new InMemoryMEditClient(), {}, readingOf({}, GAME_FOLDER_NOT_FOUND));
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModA', 'ModB']);

    expect(client.calls[0]?.args[1]).toEqual({ statCache: '/instance/stat-cache' });
    expect(outcome).toMatchObject({ notes: [{ mod: 'ModB', note: expect.stringContaining('the game folder was not found') as unknown }] });
  });

  describe('a source mod or a separator', () => {
    const unreadable: FileRead<{ gameFiles: []; notes: [] }> = { kind: 'unreadable', reason: 'it was asked' };
    const answers = { gameFilesTaken: new Map([['Source', unreadable], ['Group_separator', unreadable]]) };
    const folders = modFoldersOf('ModA', 'Source', { kind: 'separator', name: 'Group', modName: 'Group_separator' });
    const updating = async (gameFolder: GameFolder) => {
      const { commands, client } = commandsOver(answers, new InMemoryMEditClient(), {}, readingOf({ Source: '/source/Source' }, gameFolder, folders));
      client.setCommandResult('updateManifest', UPDATED);
      return commands.updateManifest(['ModA', 'Source', 'Group_separator']);
    };

    it('is handed no game files', async () => {
      expect(await updating(FOUND)).toEqual({ applied: true, ...UPDATED, refused: [], notes: [], repositoryNotes: [] });
    });

    it('is not noted when the game folder was not found', async () => {
      expect(await updating(GAME_FOLDER_NOT_FOUND)).toEqual({
        applied: true, ...UPDATED, refused: [], repositoryNotes: [],
        notes: [{ mod: 'ModA', note: 'the game folder was not found, so its manifest cannot name the game folder as its package' }],
      });
    });
  });

  it('refuses a mod whose game files the Instance adapter could not read, naming why, and updates the rest', async () => {
    const { commands, client } = commandsOver({ gameFilesTaken: new Map([['ModA', { kind: 'unreadable', reason: 'EACCES' }]]) });
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModA', 'ModB']);

    expect(sentNamesOf(client.calls[0]?.args[0])).toEqual(['ModB']);
    expect(outcome).toMatchObject({ refused: [{ item: 'ModA', reason: 'EACCES' }] });
  });

  it('names a mod whose installation file comes from a game without a Nexus domain, and sends the file without that fact', async () => {
    const { commands, client } = commandsOver({ installations: new Map([['ModA', recording({ ...INSTALLED, unpagedGame: 'EnderalSE' })]]) });
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModA']);

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

    await commands.updateManifest(['ModA', 'ModB'], { onProgress: (status) => heard.push(status) });

    expect(heard).toEqual([
      { phase: 'ReadingFiles', mod: 'ModA' }, { phase: 'ReadingFiles', mod: 'ModB' }, { phase: 'Updating', mod: 'ModA', modsDone: 1, modsTotal: 2 },
    ]);
  });

  describe('refuses a mod, naming why, and updates the rest', () => {
    const refusedFor: [string, Partial<InstanceAdapter>, string][] = [
      ['its name gives it no folder', { modFolderPath: (mod) => Promise.resolve(mod === 'ModA' ? undefined : `/mods/${mod}`) }, 'its name gives it no folder'],
      ['its installation files cannot be read', {
        installationFile: (mod) => Promise.resolve(mod === 'ModA' ? { kind: 'unreadable', reason: 'its installation file is not indexed' } : { kind: 'read', answer: undefined }),
      }, 'its installation file is not indexed'],
    ];

    it.each(refusedFor)('when %s', async (_cause, override, reason) => {
      const { commands, client } = commandsWired({ adapterOver: override });
      client.setCommandResult('updateManifest', UPDATED);

      const outcome = await commands.updateManifest(['ModA', 'ModB']);

      expect(client.calls.map((call) => sentNamesOf(call.args[0]))).toEqual([['ModB']]);
      expect(outcome).toEqual({ applied: true, ...UPDATED, refused: [{ item: 'ModA', reason }], notes: [], repositoryNotes: [] });
    });
  });

  it('does not call mEdit when no mod can be sent', async () => {
    const { commands, client } = commandsOver({ installations: new Map([['ModA', { kind: 'unreadable', reason: 'not indexed' }]]) });

    const outcome = await commands.updateManifest(['ModA']);

    expect([client.calls, outcome]).toEqual([[], { applied: true, landed: [], refused: [{ item: 'ModA', reason: 'not indexed' }], notes: [], repositoryNotes: [] }]);
  });

  it('answers the refusal of the user\'s cancel beside what mEdit updated', async () => {
    const { commands, client } = commandsOver();
    client.setCommandResult('updateManifest', { ...UPDATED, cancelRefusal: 'Could not cancel — not running.' });

    expect(await commands.updateManifest(['ModA'])).toMatchObject({ ...UPDATED, cancelRefusal: 'Could not cancel — not running.' });
  });

  it('refuses the whole gesture with the message when mEdit refused the call', async () => {
    const { commands, client } = commandsOver();
    client.setCommandResult('updateManifest', { refused: true, message: 'Could not update the manifest of 1 mod — mEdit is not running.' });

    expect(await commands.updateManifest(['ModA']))
      .toEqual({ applied: false, refusal: 'Could not update the manifest of 1 mod — mEdit is not running.' });
  });

  it('reads no further mod, and hands mEdit none, once its signal aborts while it reads', async () => {
    const cancel = new AbortController();
    const { commands, client } = commandsOver();
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModA', 'ModB'], {
      signal: cancel.signal, onProgress: (status) => { if (status.phase === 'ReadingFiles') cancel.abort(); },
    });

    expect([client.calls, outcome]).toEqual([[], { applied: true, landed: [], refused: [], notes: [], repositoryNotes: [] }]);
  });

  it('hands mEdit the signal, so a cancel stops it after the mod in hand', async () => {
    const cancel = new AbortController();
    const { commands, client } = commandsOver();
    client.setCommandResult('updateManifest', UPDATED);

    await commands.updateManifest(['ModA'], { signal: cancel.signal });

    expect(client.calls.map((call) => call.args[2])).toMatchObject([{ signal: cancel.signal }]);
  });
});

describe('modlistRepositoryCommands restore from manifest', () => {
  const RESTORED = { landed: [restoredMod({ mod: 'ModA', written: ['a.nif'] })], refused: [], notFound: [] };
  const INSTALLATION_FILE_MISSING = "was skipped: installation file 'ModA-1.0.7z' is missing.";
  const SUBMODULE_MISSING = "was skipped: its submodule 'Mod Source' is missing.";
  const sentNames = (client: InMemoryMEditClient): string[][] => client.calls.map((call) => sentNamesOf(call.args[0]));

  it('hands mEdit each mod with its folder and no installation file or submodule, its metadata files, the stat cache\'s folder and what a build needs', async () => {
    const { commands, client } = commandsOver({
      installations: new Map([['ModA', recording(INSTALLED)]]),
      metadata: new Map([['ModA', { version: '1.0', installationFile: { name: 'ModA-1.0.7z', page: 'https://www.nexusmods.com/fallout4/mods/1' } }]]),
      downloadedFiles: new Map([['ModA-1.0.7z', { kind: 'read', answer: INSTALLED }]]),
    }, new InMemoryMEditClient(), { ModA: [fileIn('/mods/ModA', 'game.esm')] }, readingOf({ ModB: '/source/Old ModB' }));
    client.setCommandResult('restoreFromManifest', RESTORED);

    await commands.restoreFromManifest(['ModA', 'ModB']);

    expect(client.calls).toEqual([{
      method: 'restoreFromManifest',
      args: [
        [
          { name: 'ModA', folder: '/mods/ModA', metadataFiles: ['meta.ini'] },
          { name: 'ModB', folder: '/mods/ModB', metadataFiles: ['meta.ini'] },
        ],
        { statCache: '/instance/stat-cache', exclusionMark: fakeInstanceAdapter().adapter.exclusionMark, archives: archiveVariants('Fallout4'), gameFolder: GAME_FOLDER, asksWhatItLacks: true },
        { onProgress: expect.any(Function) as unknown, signal: undefined },
      ],
    }]);
  });

  it('sends a mod skipped for game files the call did not hand again, with the game files of those paths, and answers both sends as one', async () => {
    const { commands, client } = commandsOver({ gameFiles: new Map([['meshes/a.nif', { path: 'Meshes/A.nif', hash: '#a' }]]) });
    client.setCommandHandler('restoreFromManifest', (_mods, facts) => Promise.resolve(facts.gameFolder?.files.length
      ? RESTORED
      : { landed: [], refused: [{ item: 'ModA', reason: 'was skipped: game file is missing.' }], notFound: [{ mod: 'ModA', gameFiles: ['meshes/a.nif'] }] }));

    const outcome = await commands.restoreFromManifest(['ModA']);

    expect(client.calls.map((call) => call.args[1])).toMatchObject([
      { gameFolder: GAME_FOLDER, asksWhatItLacks: true },
      { gameFolder: { ...GAME_FOLDER, files: [{ path: 'Meshes/A.nif', hash: '#a' }] }, asksWhatItLacks: false }]);
    expect(outcome).toEqual({ applied: true, landed: RESTORED.landed, refused: [] });
  });

  it('reads each skipped mod\'s game files on their own, hands mEdit why one of a mod\'s could not be read and not why a plainly missing one of them was not found', async () => {
    const { commands, client } = commandsOver({
      gameFiles: new Map([['meshes/b.nif', { path: 'Meshes/B.nif', hash: '#b' }]]),
      unreadableGameFiles: new Map([['textures/a.dds', 'EACCES']]),
    });
    client.setCommandResult('restoreFromManifest', {
      landed: [], refused: [{ item: 'ModA', reason: 'was skipped: game file is missing.' }],
      notFound: [{ mod: 'ModA', gameFiles: ['textures/a.dds', 'NotInGame.txt'] }, { mod: 'ModB', gameFiles: ['meshes/b.nif'] }],
    });

    const outcome = await commands.restoreFromManifest(['ModA', 'ModB']);

    expect(client.calls[1]?.args[0]).toEqual([
      expect.objectContaining({ name: 'ModA', unreadableGameFiles: { 'textures/a.dds': 'EACCES' } }), expect.objectContaining({ name: 'ModB', unreadableGameFiles: {} })]);
    expect(client.calls[1]?.args[1]).toMatchObject({ gameFolder: { files: [{ path: 'Meshes/B.nif', hash: '#b' }] } });
    expect(outcome).toMatchObject({ refused: [{ item: 'ModA', reason: 'was skipped: game file is missing.' }] });
  });

  it('hands mEdit that the game folder was not found as why each game file of a skipped mod could not be read', async () => {
    const { commands, client } = commandsOver({}, new InMemoryMEditClient(), {}, readingOf({}, GAME_FOLDER_NOT_FOUND));
    client.setCommandResult('restoreFromManifest', {
      landed: [], refused: [{ item: 'ModA', reason: 'was skipped: game file is missing.' }], notFound: [{ mod: 'ModA', gameFiles: ['a.nif', 'b.nif'] }],
    });

    await commands.restoreFromManifest(['ModA']);

    expect(client.calls[1]?.args[0]).toMatchObject([{ unreadableGameFiles: { 'a.nif': 'the game folder was not found', 'b.nif': 'the game folder was not found' } }]);
  });

  it('sends a mod skipped for a submodule the call did not hand again, with where git checks it out, its pin and its branch, and answers both sends as one', async () => {
    const pinned = { folder: '/instance/source/Mod Source', pin: 'abc123', branch: 'main' };
    const { commands, client } = commandsOver({ pins: new Map([['Mod Source', pinned]]) });
    client.setCommandHandler('restoreFromManifest', (mods) => Promise.resolve(mods[0]?.submodule === undefined
      ? { landed: [], refused: [{ item: 'ModA', reason: SUBMODULE_MISSING }], notFound: [{ mod: 'ModA', submodule: 'Mod Source', gameFiles: [] }] }
      : RESTORED));

    const outcome = await commands.restoreFromManifest(['ModA']);

    expect(client.calls.map((call) => call.args[0])).toMatchObject([[{ name: 'ModA' }], [{ name: 'ModA', submodule: pinned }]]);
    expect(outcome).toEqual({ applied: true, landed: RESTORED.landed, refused: [] });
  });

  it('says why beside a mod still skipped for a submodule the instance repository holds no pin for', async () => {
    const { commands, client } = commandsOver({ pins: new Map([['Mod Source', { lacks: 'the instance repository pins no commit at source/Mod Source' }]]) });
    client.setCommandResult('restoreFromManifest', {
      landed: [], refused: [{ item: 'ModA', reason: SUBMODULE_MISSING }], notFound: [{ mod: 'ModA', submodule: 'Mod Source', gameFiles: [] }],
    });

    const outcome = await commands.restoreFromManifest(['ModA']);

    expect(outcome).toEqual({
      applied: true, landed: [], refused: [{ item: 'ModA', reason: `${SUBMODULE_MISSING} The instance repository pins no commit at source/Mod Source.` }],
    });
  });

  it('makes the instance repository refuse a push of a pin its source mod\'s remote lacks, as git init does, once the mods landed', async () => {
    const { commands, client, adapter } = commandsOver({ repositoryOnDisk: true });
    client.setCommandResult('restoreFromManifest', { landed: [restoredMod({ mod: 'ModA', namedByNoLine: ['mine.txt'] })], refused: [], notFound: [] });

    const outcome = await commands.restoreFromManifest(['ModA']);

    expect(adapter.calls.map(({ verb }) => verb).filter((verb) => verb !== 'writeModMetadata')).toEqual(['writePathTokens', 'trashModFile', 'refuseUnpublishedPins']);
    expect(outcome).not.toHaveProperty('pushRefusalNotWritten');
  });

  it('names why the push refusal could not be written beside the mods that landed', async () => {
    const { commands, client } = commandsOver({ repositoryOnDisk: true, refusals: refusing('refuseUnpublishedPins', '/instance/.git/hooks/pre-push is not Modbench\'s') });
    client.setCommandResult('restoreFromManifest', RESTORED);

    expect(await commands.restoreFromManifest(['ModA'])).toEqual({
      applied: true, landed: RESTORED.landed, refused: [], pushRefusalNotWritten: "/instance/.git/hooks/pre-push is not Modbench's",
    });
  });

  it('writes no push refusal in an instance folder that holds no repository', async () => {
    const { commands, client, adapter } = commandsOver({ repositoryOnDisk: false });
    client.setCommandResult('restoreFromManifest', RESTORED);

    await commands.restoreFromManifest(['ModA']);

    expect(adapter.calls.map(({ verb }) => verb)).not.toContain('refuseUnpublishedPins');
  });

  it('writes the path tokens, as git init does, before it restores, and names why a path token stays', async () => {
    const { commands, client, adapter } = commandsOver({ pathTokenLeft: 'ModOrganizer.ini still holds a path token' });
    let writtenBeforeRestore: string[] = [];
    client.setCommandHandler('restoreFromManifest', () => {
      writtenBeforeRestore = adapter.calls.map(({ verb }) => verb);
      return Promise.resolve(RESTORED);
    });

    const outcome = await commands.restoreFromManifest(['ModA']);

    expect([writtenBeforeRestore, outcome]).toEqual([
      ['writePathTokens'],
      { applied: true, landed: RESTORED.landed, refused: [], pathTokensNotWritten: 'ModOrganizer.ini still holds a path token' },
    ]);
  });

  it('reports the phase of reading each mod\'s files, then mEdit\'s progress restoring them', async () => {
    const { commands, client } = commandsOver();
    client.setCommandHandler('restoreFromManifest', (_mods, _facts, options) => {
      options?.onProgress?.({ mod: 'ModA', modsDone: 0, modsTotal: 1 });
      return Promise.resolve(RESTORED);
    });
    const heard: unknown[] = [];

    await commands.restoreFromManifest(['ModA'], { onProgress: (status) => heard.push(status) });

    expect(heard).toEqual([{ phase: 'ReadingFiles', mod: 'ModA' }, { phase: 'Restoring', mod: 'ModA', modsDone: 0, modsTotal: 1 }]);
  });

  it('sends a mod skipped for an installation file the call did not hand again, with the downloaded file of that name, and answers both sends as one', async () => {
    const { commands, client } = commandsOver({ downloadedFiles: new Map([['ModA-1.0.7z', { kind: 'read', answer: INSTALLED }]]) });
    client.setCommandHandler('restoreFromManifest', (mods) => Promise.resolve(mods[0]?.installationFile === undefined
      ? { landed: [], refused: [{ item: 'ModA', reason: INSTALLATION_FILE_MISSING }], notFound: [{ mod: 'ModA', installationFile: { name: 'ModA-1.0.7z', hash: 'H' }, gameFiles: [] }] }
      : RESTORED));

    const outcome = await commands.restoreFromManifest(['ModA']);

    expect(client.calls.map((call) => call.args[0])).toMatchObject([[{}], [{ installationFile: INSTALLED }]]);
    expect(outcome).toEqual({ applied: true, landed: RESTORED.landed, refused: [] });
  });

  it('hands mEdit why an installation file the Instance adapter could not read could not be read', async () => {
    const { commands, client } = commandsOver({ downloadedFiles: new Map([['ModA-1.0.7z', { kind: 'unreadable', reason: 'EACCES' }]]) });
    client.setCommandResult('restoreFromManifest', {
      landed: [], refused: [{ item: 'ModA', reason: INSTALLATION_FILE_MISSING }], notFound: [{ mod: 'ModA', installationFile: { name: 'ModA-1.0.7z', hash: 'H' }, gameFiles: [] }],
    });

    await commands.restoreFromManifest(['ModA']);

    expect(client.calls[1]?.args[0]).toMatchObject([{ name: 'ModA', unreadableInstallationFile: 'EACCES' }]);
  });

  describe('an installation file the downloads folder lacks', () => {
    const LACKED: ManifestInstallationFile = { name: 'ModA-1.0.7z', hash: 'the bytes', page: FILE_78.page };
    const lackedUntilHanded = (client: InMemoryMEditClient, installationFile = LACKED): void => {
      client.setCommandHandler('restoreFromManifest', (mods) => Promise.resolve(mods[0]?.installationFile === undefined
        ? { landed: [], refused: [{ item: 'ModA', reason: INSTALLATION_FILE_MISSING }], notFound: [{ mod: 'ModA', installationFile, gameFiles: [] }] }
        : RESTORED));
    };

    it('is downloaded from the page on Nexus its manifest names, put with what Nexus knows of it, and handed in the second send', async () => {
      const { nexus } = await nexusServing(servingFile78('the bytes'));
      const { commands, client, adapter } = commandsWired({ nexus });
      lackedUntilHanded(client);
      const heard: unknown[] = [];

      const outcome = await commands.restoreFromManifest(['ModA'], { onProgress: (status) => { heard.push(status); } });

      expect(adapter.calls).toContainEqual({ verb: 'putDownloadedFile', name: 'ModA-1.0.7z', info: expect.objectContaining({ game: 'fallout4', modID: '7', fileID: '78', name: 'Main' }) as unknown });
      expect(client.calls[1]?.args[0]).toMatchObject([{ installationFile: { path: '/downloads/ModA-1.0.7z', hash: 'the bytes' } }]);
      expect(heard).toContainEqual({ phase: 'Downloading', file: 'ModA-1.0.7z' });
      expect(outcome).toEqual({ applied: true, landed: RESTORED.landed, refused: [] });
    });

    it.each([
      ['its manifest names no file on Nexus', { ...LACKED, page: undefined }, true, ' Its manifest names no file on Nexus to download it from.'],
      ['Nexus does not send it, as while logged out', LACKED, false, ' It could not be downloaded from Nexus: You are not logged in to Nexus.'],
    ])('skips the mod when %s, naming why it was not downloaded', async (_name, installationFile, loggedIn, why) => {
      const { nexus } = await nexusServing(servingFile78('the bytes'), loggedIn);
      const { commands, client } = commandsWired({ nexus });
      lackedUntilHanded(client, installationFile);

      const outcome = await commands.restoreFromManifest(['ModA']);

      expect(outcome).toEqual({ applied: true, landed: [], refused: [{ item: 'ModA', reason: INSTALLATION_FILE_MISSING + why }] });
    });

    it('skips the mod when Nexus sends another file than its manifest names, putting none', async () => {
      const { nexus } = await nexusServing(servingFile78('other bytes'));
      const { commands, client } = commandsWired({ nexus });
      lackedUntilHanded(client);

      const outcome = await commands.restoreFromManifest(['ModA']);

      expect(outcome).toMatchObject({ refused: [{ item: 'ModA', reason: `${INSTALLATION_FILE_MISSING} It could not be downloaded from Nexus: the file Nexus sent is not the one its manifest names.` }] });
    });

    it('names why the Instance adapter could not put it', async () => {
      const { nexus } = await nexusServing(servingFile78('the bytes'));
      const { commands, client } = commandsWired({ nexus }, { refusals: refusing('putDownloadedFile', 'ENOSPC') });
      lackedUntilHanded(client);

      const outcome = await commands.restoreFromManifest(['ModA']);

      expect(outcome).toMatchObject({ refused: [{ item: 'ModA', reason: `${INSTALLATION_FILE_MISSING} It could not be downloaded from Nexus: ENOSPC.` }] });
    });

    it('lets the server\'s connection go when the Instance adapter refuses the file before it reads it', async () => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; } });
      const { nexus } = await nexusServing({ ...servingFile78('the bytes'), [FILE_78.server]: new Response(body) });
      const { commands, client } = commandsWired({ nexus }, { refusals: refusing('putDownloadedFile', 'ENOSPC') });
      lackedUntilHanded(client);

      await commands.restoreFromManifest(['ModA']);

      expect(cancelled).toBe(true);
    });

    it('asks Nexus nothing for an installation file the downloads folder holds', async () => {
      const { nexus, sent } = await nexusServing(servingFile78('the bytes'));
      const { commands, client } = commandsWired({ nexus }, { downloadedFiles: new Map([['ModA-1.0.7z', { kind: 'read', answer: INSTALLED }]]) });
      lackedUntilHanded(client);

      await commands.restoreFromManifest(['ModA']);

      expect(sent).toEqual([]);
    });

    it('downloads no further file and sends nothing again once its signal aborts, naming each mod it skipped as not finished', async () => {
      const cancel = new AbortController();
      const { nexus, sent } = await nexusServing({ ...servingFile78('the bytes'), [FILE_78.record]: new Response('', { status: 404 }) });
      const { commands, client } = commandsWired({ nexus });
      client.setCommandResult('restoreFromManifest', {
        landed: [], refused: [{ item: 'ModA', reason: INSTALLATION_FILE_MISSING }, { item: 'ModB', reason: "was skipped: installation file 'ModB.7z' is missing." }],
        notFound: [{ mod: 'ModA', installationFile: LACKED, gameFiles: [] }, { mod: 'ModB', installationFile: { ...LACKED, name: 'ModB.7z' }, gameFiles: [] }],
      });

      const outcome = await commands.restoreFromManifest(['ModA', 'ModB'], { onProgress: (status) => { if (status.phase === 'Downloading') cancel.abort(); }, signal: cancel.signal });

      const notFinished = 'was not finished: the restore was cancelled. Restoring it again finishes it.';
      expect([sent.map(({ url }) => url), client.calls.length, outcome]).toEqual([
        [FILE_78.record], 1, { applied: true, landed: [], refused: [{ item: 'ModA', reason: notFinished }, { item: 'ModB', reason: notFinished }] },
      ]);
    });
  });

  it('sends no skipped mod again once its signal aborts, handing mEdit the signal, so a cancel stops after the mod in hand', async () => {
    const cancel = new AbortController();
    const { commands, client } = commandsOver();
    client.setCommandHandler('restoreFromManifest', () => {
      cancel.abort();
      return Promise.resolve({ landed: [], refused: [], notFound: [{ mod: 'ModA', installationFile: { name: 'ModA-1.0.7z', hash: 'H' }, gameFiles: [] }] });
    });

    await commands.restoreFromManifest(['ModA'], { signal: cancel.signal });

    expect(client.calls.map((call) => call.args[2])).toMatchObject([{ signal: cancel.signal }]);
  });

  it('names each mod a cancel left unfinished, the one it never sent again and the one mEdit never reached, beside the mod that landed', async () => {
    const cancel = new AbortController();
    const { commands, client } = commandsOver();
    client.setCommandHandler('restoreFromManifest', () => {
      cancel.abort();
      return Promise.resolve({
        landed: RESTORED.landed, refused: [{ item: 'ModB', reason: "was skipped: installation file 'ModB.7z' is missing." }],
        notFound: [{ mod: 'ModB', installationFile: { name: 'ModB.7z', hash: 'H' }, gameFiles: [] }],
      });
    });

    const outcome = await commands.restoreFromManifest(['ModA', 'ModB', 'ModC'], { signal: cancel.signal });

    expect(outcome).toEqual({
      applied: true, landed: RESTORED.landed,
      refused: ['ModB', 'ModC'].map((mod) => ({ item: mod, reason: `was not finished: the restore was cancelled. Restoring it again finishes it.` })),
    });
  });

  it('names each mod a cancel stopped before it was read as unfinished', async () => {
    const cancel = new AbortController();
    const { commands } = commandsOver();

    const outcome = await commands.restoreFromManifest(['ModA'], { signal: cancel.signal, onProgress: () => { cancel.abort(); } });

    expect(outcome).toEqual({
      applied: true, landed: [], refused: [{ item: 'ModA', reason: "was not finished: the restore was cancelled. Restoring it again finishes it." }],
    });
  });

  it('answers the refusal of the user\'s cancel beside what mEdit restored', async () => {
    const { commands, client } = commandsOver();
    client.setCommandResult('restoreFromManifest', { ...RESTORED, cancelRefusal: 'Could not cancel — not running.' });

    expect(await commands.restoreFromManifest(['ModA'])).toMatchObject({ cancelRefusal: 'Could not cancel — not running.' });
  });

  it('answers the refusal of a cancel during the second send beside what both sends restored', async () => {
    const { commands, client } = commandsOver({ downloadedFiles: new Map([['ModA-1.0.7z', { kind: 'read', answer: INSTALLED }]]) });
    client.setCommandHandler('restoreFromManifest', (mods) => Promise.resolve(mods[0]?.installationFile === undefined
      ? { landed: [], refused: [], notFound: [{ mod: 'ModA', installationFile: { name: 'ModA-1.0.7z', hash: 'H' }, gameFiles: [] }] }
      : { landed: [restoredMod({ mod: 'ModA', written: ['a.nif'] })], refused: [], notFound: [], cancelRefusal: 'Could not cancel — not running.' }));

    expect(await commands.restoreFromManifest(['ModA'])).toMatchObject({ cancelRefusal: 'Could not cancel — not running.' });
  });

  it('refuses a mod the Instance adapter cannot answer, naming why, and restores the rest', async () => {
    const { commands, client } = commandsWired({
      adapterOver: { modFolderPath: (mod) => Promise.resolve(mod === 'ModA' ? undefined : `/mods/${mod}`) },
    });
    client.setCommandResult('restoreFromManifest', { landed: [restoredMod({ mod: 'ModB' })], refused: [], notFound: [] });

    const outcome = await commands.restoreFromManifest(['ModA', 'ModB']);

    expect([sentNames(client), outcome]).toEqual([
      [['ModB']], { applied: true, landed: [restoredMod({ mod: 'ModB' })], refused: [{ item: 'ModA', reason: 'its name gives it no folder' }] },
    ]);
  });

  it('names every mod of a call that failed part way as not finished, since none had its files no line names trashed', async () => {
    const { commands, client } = commandsOver();
    client.setCommandHandler('restoreFromManifest', (_mods, _facts, options) => {
      options?.onProgress?.({ mod: 'ModA', modsDone: 0, modsTotal: 3 });
      options?.onProgress?.({ mod: 'ModB', modsDone: 1, modsTotal: 3 });
      return Promise.resolve({ refused: true, message: 'Could not restore 3 mods — mEdit stopped.' });
    });

    expect(await commands.restoreFromManifest(['ModA', 'ModB', 'ModC'])).toEqual({
      applied: false, refusal: 'Could not restore 3 mods — mEdit stopped.', unfinished: ['ModA', 'ModB', 'ModC'],
    });
  });

  it('trashes the files no line names of each mod the first call landed when the second call fails, and names the second call\'s mods', async () => {
    const { commands, client, adapter } = commandsOver({ downloadedFiles: new Map([['ModB.7z', { kind: 'read', answer: INSTALLED }]]) });
    client.setCommandHandler('restoreFromManifest', (mods) => Promise.resolve(mods.length === 2
      ? { landed: [restoredMod({ mod: 'ModA', namedByNoLine: ['mine.txt'] })], refused: [], notFound: [{ mod: 'ModB', installationFile: { name: 'ModB.7z', hash: 'H' }, gameFiles: [] }] }
      : { refused: true as const, message: 'Could not restore 1 mod — mEdit stopped.' }));

    const outcome = await commands.restoreFromManifest(['ModA', 'ModB']);

    expect([adapter.calls.filter(({ verb }) => verb === 'trashModFile'), outcome]).toEqual([
      [{ verb: 'trashModFile', mod: 'ModA', relativePath: 'mine.txt' }],
      { applied: false, refusal: 'Could not restore 1 mod — mEdit stopped.', unfinished: ['ModB'] },
    ]);
  });

  it('sends each file no line names in a mod that landed to the trash, through the Instance adapter', async () => {
    const { commands, client, adapter } = commandsOver();
    client.setCommandResult('restoreFromManifest', { landed: [restoredMod({ mod: 'ModA', namedByNoLine: ['mine.txt', 'meshes/b.nif'] })], refused: [], notFound: [] });

    await commands.restoreFromManifest(['ModA']);

    expect(adapter.calls.filter(({ verb }) => verb === 'trashModFile')).toEqual([
      { verb: 'trashModFile', mod: 'ModA', relativePath: 'mine.txt' }, { verb: 'trashModFile', mod: 'ModA', relativePath: 'meshes/b.nif' },
    ]);
  });

  it('answers a mod with a file the trash refused as not finished, naming the file and why', async () => {
    const { commands, client } = commandsOver({ refusals: refusing('trashModFile', 'the trash is full') });
    client.setCommandResult('restoreFromManifest', { landed: [restoredMod({ mod: 'ModA', namedByNoLine: ['mine.txt'] })], refused: [], notFound: [] });

    expect(await commands.restoreFromManifest(['ModA'])).toEqual({
      applied: true, landed: [],
      refused: [{ item: 'ModA', reason: "was not finished: 'mine.txt' could not be moved to the trash: the trash is full. Restoring it again finishes it." }],
    });
  });

  it('writes each landed mod\'s metadata as its manifest says, through the Instance adapter, after its files no line names went to the trash', async () => {
    const { commands, client, adapter } = commandsOver();
    const metadata = { version: '1.0', installationFile: { name: 'ModA-1.0.7z', page: 'https://www.nexusmods.com/fallout4/mods/1' } };
    client.setCommandResult('restoreFromManifest', { landed: [restoredMod({ mod: 'ModA', namedByNoLine: ['mine.txt'], metadata })], refused: [], notFound: [] });

    await commands.restoreFromManifest(['ModA']);

    expect(adapter.calls).toEqual([
      { verb: 'writePathTokens' }, { verb: 'trashModFile', mod: 'ModA', relativePath: 'mine.txt' }, { verb: 'writeModMetadata', mod: 'ModA', metadata },
    ]);
  });

  it('writes the metadata of a mod the second call landed, and of no mod that was skipped', async () => {
    const { commands, client, adapter } = commandsOver({ downloadedFiles: new Map([['ModA-1.0.7z', { kind: 'read', answer: INSTALLED }]]) });
    const metadata = { version: '2.0' };
    client.setCommandHandler('restoreFromManifest', (mods) => Promise.resolve(mods.length === 2
      ? { landed: [], refused: [{ item: 'ModA', reason: 'missing' }, { item: 'ModB', reason: "its package does not hold 'b.nif'" }], notFound: [{ mod: 'ModA', installationFile: { name: 'ModA-1.0.7z', hash: 'H' }, gameFiles: [] }] }
      : { landed: [restoredMod({ mod: 'ModA', metadata })], refused: [], notFound: [] }));

    await commands.restoreFromManifest(['ModA', 'ModB']);

    expect(adapter.calls).toEqual([{ verb: 'writePathTokens' }, { verb: 'writeModMetadata', mod: 'ModA', metadata }]);
  });

  it('answers a mod whose metadata could not be written as not finished, naming why', async () => {
    const { commands, client } = commandsOver({ refusals: refusing('writeModMetadata', 'its source names the Nexus game \'x\'') });
    client.setCommandResult('restoreFromManifest', {
      landed: [restoredMod({ mod: 'ModA', metadata: { version: '1' } })], refused: [], notFound: [],
    });

    expect(await commands.restoreFromManifest(['ModA'])).toEqual({
      applied: true, landed: [],
      refused: [{ item: 'ModA', reason: "was not finished: its metadata could not be written: its source names the Nexus game 'x'. Restoring it again finishes it." }],
    });
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
    const { commands, client } = commandsWired({ adapterOver: { modFolderPath: () => Promise.resolve(undefined) } });

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
