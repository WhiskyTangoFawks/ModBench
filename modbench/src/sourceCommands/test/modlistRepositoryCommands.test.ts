import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { StepTasks } from '../steps';
import { recordingTasks } from '../../test/recordingTasks';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { ManifestInstallationFile, ManifestStep } from '../../client';
import type { SubmodulesCloned } from '../../client/MEditClient';
import type { FileRead, FoundGameFolder, GameFolder, GamePlace, InstallationFile, InstanceAdapter, InstanceReading, ModFolders, OriginFile, OriginFiles, OtherManifest } from '../../instanceAdapter/instanceAdapter';
import { fakeInstanceAdapter, fileIn, modFoldersOf, pluginFilesHeld, readingFixture, refusing, sourceModsOf, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { foldersRefused } from '../../instanceAdapter/foldersRefused';
import { modlistRepositoryCommands } from '../modlistRepositoryCommands';
import { archiveVariants } from '../sourceCommands';
import type { HostGit } from '../../ports/repository';
import { hostGitFailingToActivate, hostGitRecordingInits } from './hostGitDouble';
import { GAME_FOLDER_NOT_FOUND } from '../../test/mo2/gameFolderNotFound';
import { loadOrderStatusEventFixture } from '../../client/test/fixtures';
import { restoredMod } from '../../test/restoredMod';
import { answeringFrom, FILE_78, nexusAnswering, nexusServing, servingFile78 } from '../../nexus/test/nexusDouble';
import type { Nexus } from '../../nexus/nexus';


const INSTALLED: InstallationFile = { path: '/downloads/ModA-1.0.7z', size: 10, hash: 'H', entries: [{ path: 'textures/a.dds', hash: 'E' }] };

const recording = (file: InstallationFile): FileRead<InstallationFile> => ({ kind: 'read', answer: file });
const FOUND: FoundGameFolder = { kind: 'found', root: '/game', dataFolder: '/game/Data' };
const readingOf = (sourceFolders: Record<string, string> = {}, gameFolder: GameFolder = FOUND, modFolders?: ModFolders): Partial<InstanceReading> =>
  ({ gameFolder, sourceMods: sourceModsOf(sourceFolders), modFolders });
const GAME_FOLDER = { name: 'Fallout4', root: '/game', files: [] };
const filesIn = (filesByMod: Record<string, readonly OriginFile[]>): ReadonlyMap<string, OriginFiles> =>
  new Map(Object.entries(filesByMod).map(([mod, files]) => [mod, { origin: mod, folder: `/instance/mods/${mod}`, files, folders: [], notes: [] }]));

const loggedOutOfNexus = (): Nexus => nexusAnswering(answeringFrom({})).nexus;

const STOCK_GAME: OtherManifest = { name: 'Stock Game/', folder: '/instance/Stock Game' };

const WHAT_A_MOD_MANAGER_WOULD_HOLD_OF_IT_AS_A_MOD: InstanceAnswers = {
  installations: new Map([[STOCK_GAME.name, recording(INSTALLED)]]),
  metadata: new Map([[STOCK_GAME.name, { version: '9' }]]),
  unwritableMetadata: new Map([[STOCK_GAME.name, 'it was asked']]),
};

const sentNamesOf = (mods: unknown): string[] => (Array.isArray(mods) ? mods.map((mod: { name: string }) => mod.name) : []);

interface Wiring { nexus?: Nexus; hostGit?: HostGit<string>; adapterOver?: Partial<InstanceAdapter>; tasks?: StepTasks}

function commandsOver(
  answers: InstanceAnswers = {}, client = new InMemoryMEditClient(), filesByMod: Record<string, readonly OriginFile[]> = {}, instance: Partial<InstanceReading> = readingOf(),
  { nexus = loggedOutOfNexus(), hostGit, adapterOver = {}, tasks = recordingTasks() }: Wiring = {},
) {
  const adapter = fakeInstanceAdapter(readingFixture({ modFiles: filesIn(filesByMod), ...instance }), answers);
  const repositories: string[] = [];
  const commands = modlistRepositoryCommands({
    client, adapter: { ...adapter.adapter, ...adapterOver }, nexus, instanceRoot: '/instance',
    hostGit: hostGit ?? hostGitRecordingInits(repositories), trash: () => Promise.resolve(), tasks,
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
  const UPDATED = { landed: [{ mod: 'ModA', manifestWritten: true, notInPackage: [], otherBytes: [] }], refused: [] };

  it('hands mEdit each mod with its folder, its installation files, its metadata files and a source mod\'s source folder, and the stat cache\'s folder', async () => {
    const { commands, client } = commandsOver({
      installations: new Map([['ModA', recording(INSTALLED)]]),
      metadata: new Map([['ModA', { version: '1.2.3' }]]),
    }, new InMemoryMEditClient(), { ModA: [fileIn('/instance/mods/ModA', 'game.ESM')], ModB: [fileIn('/instance/mods/ModB', 'a.nif')] }, readingOf({ ModB: '/source/Old ModB' }));
    client.setCommandResult('updateManifest', UPDATED);

    await commands.updateManifest(['ModA', 'ModB']);

    expect(client.calls).toEqual([{
      method: 'updateManifest',
      args: [
        [
          { name: 'ModA', folder: '/instance/mods/ModA', installationFile: INSTALLED, metadataFiles: ['meta.ini'], version: '1.2.3', gameFolder: GAME_FOLDER },
          { name: 'ModB', folder: '/instance/mods/ModB', metadataFiles: ['meta.ini'], sourceFolder: '/source/Old ModB', gameFolder: GAME_FOLDER },
        ],
        { statCache: '/instance/stat-cache', downloadedFiles: [] },
        { onProgress: expect.any(Function) as unknown, signal: undefined },
      ],
    }]);
  });

  it('makes each source mod with a remote a submodule once mEdit has answered, and names a source mod that is not one', async () => {
    const { commands, client, adapter } = commandsOver({ submodules: { notes: [{ mod: 'ModA', note: 'it has a remote but no branch checked out' }], other: ['source/Odd is not a source mod'] } });
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModA']);

    expect([adapter.calls, outcome]).toMatchObject([[{ verb: 'writeSubmodules' }, { verb: 'writeOtherManifestLines' }, { verb: 'keepOutOfPublisher' }], { applied: true, notes: [{ mod: 'ModA', note: 'it has a remote but no branch checked out' }], repositoryNotes: ['source/Odd is not a source mod'] }]);
  });

  it('reports each path no path token names, naming its file, and leaves the path tokens as git init wrote them', async () => {
    const { commands, client, adapter } = commandsOver({ pathsOutsideFolders: [{ file: 'ModOrganizer.ini', path: 'C:/Modding/x.exe' }] });
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModA']);

    expect([adapter.calls.map(({ verb }) => verb), outcome]).toMatchObject([['writeSubmodules', 'writeOtherManifestLines', 'keepOutOfPublisher'], {
      applied: true, repositoryNotes: ['ModOrganizer.ini holds a path no path token names: C:/Modding/x.exe'],
    }]);
  });

  it('names the failure to read the paths beside the manifests that landed', async () => {
    const { commands, client } = commandsOver({ unreadReads: { pathsOutsideFolders: 'git is not available' } });
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModA']);

    expect(outcome).toMatchObject({
      applied: true, landed: UPDATED.landed, repositoryNotes: ["the paths the instance repository's files hold could not be read: git is not available"],
    });
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

  it('names the failure to write the lines of the other manifests beside the manifests that landed', async () => {
    const { commands, client } = commandsOver({ refusals: refusing('writeOtherManifestLines', '/instance/.gitignore has a marker with no match') });
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModA']);

    expect(outcome).toMatchObject({ applied: true, landed: UPDATED.landed, repositoryNotes: ['/instance/.gitignore has a marker with no match'] });
  });

  it('hands mEdit a folder outside the mod folders by its name, with its folder, the game files its files may be, and none of what a mod manager holds of a mod', async () => {
    const stockGameFiles: FileRead<{ gameFiles: { path: string; hash: string }[]; notes: string[] }> =
      { kind: 'read', answer: { gameFiles: [{ path: 'Meshes/A.nif', hash: '#a' }], notes: [] } };
    const { commands, client } = commandsOver({ ...WHAT_A_MOD_MANAGER_WOULD_HOLD_OF_IT_AS_A_MOD, gameFilesTaken: new Map([['Stock Game', stockGameFiles]]) });
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModA'], {}, [STOCK_GAME]);

    expect(client.calls[0]?.args[0]).toEqual([
      { name: 'ModA', folder: '/instance/mods/ModA', metadataFiles: ['meta.ini'], gameFolder: GAME_FOLDER },
      { name: 'Stock Game/', folder: '/instance/Stock Game', metadataFiles: [], gameFolder: { ...GAME_FOLDER, files: [{ path: 'Meshes/A.nif', hash: '#a' }] } },
    ]);
    expect(outcome).toMatchObject({ applied: true, refused: [], notes: [] });
  });

  it('refuses a mod whose metadata cannot be read, naming why, and updates the rest', async () => {
    const { commands, client } = commandsOver({ unreadableMetadata: new Map([['ModA', 'EISDIR: meta.ini']]) });
    client.setCommandResult('updateManifest', { landed: [{ mod: 'ModB', manifestWritten: true, notInPackage: [], otherBytes: [] }], refused: [] });

    const outcome = await commands.updateManifest(['ModA', 'ModB']);

    expect(client.calls.map((call) => sentNamesOf(call.args[0]))).toEqual([['ModB']]);
    expect(outcome).toMatchObject({ applied: true, refused: [{ item: 'ModA', reason: 'its metadata could not be read: EISDIR: meta.ini' }] });
  });

  it('hands mEdit, with each mod, the game files that mod\'s files may take, whether or not it has an installation file', async () => {
    const taken = (path: string): FileRead<{ gameFiles: { path: string; hash: string }[]; notes: string[] }> =>
      ({ kind: 'read', answer: { gameFiles: [{ path, hash: `#${path}` }], notes: [] } });
    const { commands, client } = commandsOver({
      installations: new Map([['ModA', recording(INSTALLED)]]),
      gameFilesTaken: new Map([['ModA', taken('Textures/a.dds')], ['ModB', taken('Meshes/B.nif')]]),
    });
    client.setCommandResult('updateManifest', UPDATED);

    await commands.updateManifest(['ModA', 'ModB']);

    expect(client.calls[0]?.args[0]).toMatchObject([
      { name: 'ModA', gameFolder: { ...GAME_FOLDER, files: [{ path: 'Textures/a.dds', hash: '#Textures/a.dds' }] } },
      { name: 'ModB', gameFolder: { ...GAME_FOLDER, files: [{ path: 'Meshes/B.nif', hash: '#Meshes/B.nif' }] } },
    ]);
  });

  const NEVER_HASHED: InstallationFile = { ...INSTALLED, path: '/downloads/Other.7z', page: 'https://example.test/other' };
  const ANOTHER_NEVER_HASHED: InstallationFile = { ...INSTALLED, path: '/downloads/Another.7z' };

  it('hands mEdit every downloaded file with its entries, one the hash index never hashed among them, once for the whole call', async () => {
    const { commands, client } = commandsOver({ downloadedFilesHashed: { files: [INSTALLED], lacking: [NEVER_HASHED], notes: [] } });
    client.setCommandResult('updateManifest', UPDATED);

    await commands.updateManifest(['ModA', 'ModB']);

    expect(client.calls.map((call) => call.args[1])).toEqual([{ statCache: '/instance/stat-cache', downloadedFiles: [INSTALLED, NEVER_HASHED] }]);
  });

  it('reports, while it hashes the downloaded files the hash index lacks, how many are left', async () => {
    const { commands, client } = commandsOver({ downloadedFilesHashed: { files: [INSTALLED], lacking: [NEVER_HASHED], notes: [] } });
    client.setCommandResult('updateManifest', UPDATED);
    const heard: unknown[] = [];

    await commands.updateManifest(['ModA'], { onProgress: (status) => heard.push(status) });

    expect(heard).toEqual([{ phase: 'ReadingFiles', mod: 'ModA' }, { phase: 'Hashing', left: 1 }]);
  });

  it('hands mEdit nothing, so writes no manifest, once its signal aborts while it hashes the downloaded files', async () => {
    const cancel = new AbortController();
    const { commands, client } = commandsOver({ downloadedFilesHashed: { files: [], lacking: [NEVER_HASHED, ANOTHER_NEVER_HASHED], notes: [] } });
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModA'], {
      signal: cancel.signal, onProgress: (status) => { if (status.phase === 'Hashing') cancel.abort(); },
    });

    expect([client.calls, outcome]).toEqual([[], { applied: true, landed: [], refused: [], notes: [], repositoryNotes: [] }]);
  });

  it('updates every mod and reports why a downloaded file could not be read', async () => {
    const { commands, client } = commandsOver({ downloadedFilesHashed: { files: [], notes: ['/downloads/Bad.7z could not be read: EIO'] } });
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModA', 'ModB']);

    expect(sentNamesOf(client.calls[0]?.args[0])).toEqual(['ModA', 'ModB']);
    expect(outcome).toMatchObject({ applied: true, repositoryNotes: ['/downloads/Bad.7z could not be read: EIO'] });
  });

  it('updates a mod whose installation file yields its bytes though its game files cannot be read, noting why', async () => {
    const { commands, client } = commandsOver({
      installations: new Map([['ModA', recording(INSTALLED)]]),
      gameFilesTaken: new Map([['ModA', { kind: 'unreadable', reason: 'EACCES' }]]),
    });
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModA']);

    expect(sentNamesOf(client.calls[0]?.args[0])).toEqual(['ModA']);
    expect(outcome).toMatchObject({ refused: [], notes: [{ mod: 'ModA', note: expect.stringContaining('EACCES') as unknown }] });
  });

  it('names a mod with no installation file when the game folder was not found, and sends it no game folder', async () => {
    const { commands, client } = commandsOver({ installations: new Map([['ModA', recording(INSTALLED)]]) }, new InMemoryMEditClient(), {}, readingOf({}, GAME_FOLDER_NOT_FOUND));
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModA', 'ModB']);

    expect(client.calls[0]?.args[0]).not.toContainEqual(expect.objectContaining({ gameFolder: expect.anything() as unknown }));
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
      ['its name gives it no folder', { modFolderPath: (mod) => Promise.resolve(mod === 'ModA' ? undefined : `/instance/mods/${mod}`) }, 'its name gives it no folder'],
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

  describe('from a fresh clone, whose submodules the source folder lacks', () => {
    const PINNED = { folder: '/instance/source/Mod Source', pin: 'abc123', branch: 'main' };

    function freshClone(cloned: () => Promise<SubmodulesCloned>) {
      let clonedYet = false;
      const sourceMods = () => Promise.resolve(sourceModsOf(clonedYet ? { ModS: PINNED.folder } : {}));
      const wired = commandsOver({ uncloned: [{ name: 'Mod Source', ...PINNED }] }, new InMemoryMEditClient(), {}, readingOf(), { adapterOver: { sourceMods } });
      wired.client.setCommandHandler('cloneSubmodules', () => { clonedYet = true; return cloned(); });
      wired.client.setCommandResult('restoreFromManifest', { landed: [restoredMod({ mod: 'ModS', written: ['ModS.esp'] })], refused: [], notFound: [] });
      return wired;
    }

    it('clones each first, then restores with every manifest the mod its manifest builds, which no folder holds yet', async () => {
      const { commands, client } = freshClone(() => Promise.resolve({ applied: [{ folder: PINNED.folder }], refused: [] }));

      const outcome = await commands.restoreFromManifest([], {}, true);

      expect(client.calls.map(({ method }) => method)).toEqual(['cloneSubmodules', 'restoreFromManifest']);
      expect(client.calls[0]?.args[0]).toEqual([PINNED]);
      expect(client.calls[1]?.args[0]).toMatchObject([{ name: 'ModS', sourceFolder: PINNED.folder }]);
      expect(outcome).toMatchObject({ applied: true, landed: [{ mod: 'ModS' }], refused: [] });
    });

    it('names a submodule it could not clone, or whose pin the instance repository lacks, and restores the rest', async () => {
      const { commands } = freshClone(() => Promise.resolve({ applied: [], refused: [{ item: PINNED.folder, refusal: 'NotCloned', message: 'its remote holds no commit abc123' }] }));

      const outcome = await commands.restoreFromManifest(['ModA'], {}, false);

      expect(outcome).toMatchObject({ applied: true, refused: [{ item: 'Mod Source', reason: 'was not cloned: its remote holds no commit abc123.' }] });
    });

    it('carries why a cloned submodule was left off its branch to the mod it restored', async () => {
      const { commands } = freshClone(() => Promise.resolve({ applied: [{ folder: PINNED.folder, leftDetached: "its branch 'main' is at def456" }], refused: [] }));

      const outcome = await commands.restoreFromManifest([], {}, true);

      expect(outcome).toMatchObject({ applied: true, landed: [{ mod: 'ModS', leftDetached: "its branch 'main' is at def456" }] });
    });
  });

  it('hands mEdit each mod with its folder and no installation file or submodule, its metadata files, a source mod\'s source folder, the stat cache\'s folder, what a build needs and each task this machine has', async () => {
    const { commands, client } = commandsOver({
      installations: new Map([['ModA', recording(INSTALLED)]]),
      metadata: new Map([['ModA', { version: '1.0', installationFile: { name: 'ModA-1.0.7z', page: 'https://www.nexusmods.com/fallout4/mods/1' } }]]),
      downloadedFiles: new Map([['ModA-1.0.7z', { kind: 'read', answer: INSTALLED }]]),
    }, new InMemoryMEditClient(), { ModA: [fileIn('/instance/mods/ModA', 'game.esm')] }, readingOf({ ModB: '/source/Old ModB' }), { tasks: recordingTasks(['Zip']) });
    client.setCommandResult('restoreFromManifest', RESTORED);

    await commands.restoreFromManifest(['ModA', 'ModB']);

    const facts = { statCache: '/instance/stat-cache', exclusionMark: fakeInstanceAdapter().adapter.exclusionMark, archives: archiveVariants('Fallout4'), gameFolder: GAME_FOLDER, asksWhatItLacks: true, tasks: ['Zip'] };
    const options = { onProgress: expect.any(Function) as unknown, signal: undefined };
    expect(client.calls).toEqual([
      { method: 'restoreFromManifest', args: [[{ name: 'ModA', folder: '/instance/mods/ModA', metadataFiles: ['meta.ini'] }], facts, options] },
      { method: 'restoreFromManifest', args: [[{ name: 'ModB', folder: '/instance/mods/ModB', metadataFiles: ['meta.ini'], sourceFolder: '/source/Old ModB' }], facts, options] },
    ]);
  });

  it('sends a mod skipped for game files the call did not hand again, with the game files of those paths, and answers both sends as one', async () => {
    const { commands, client } = commandsOver({ gameFiles: new Map([['meshes/a.nif', { path: 'Meshes/A.nif', hash: '#a' }]]) });
    client.setCommandHandler('restoreFromManifest', (_mods, facts) => Promise.resolve(facts.gameFolder?.files.length
      ? RESTORED
      : { landed: [], refused: [{ item: 'ModA', reason: 'was skipped: game file is missing.' }], notFound: [{ mod: 'ModA', installationFiles: [], gameFiles: ['meshes/a.nif'] }] }));

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
      notFound: [{ mod: 'ModA', installationFiles: [], gameFiles: ['textures/a.dds', 'NotInGame.txt'] }, { mod: 'ModB', installationFiles: [], gameFiles: ['meshes/b.nif'] }],
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
      landed: [], refused: [{ item: 'ModA', reason: 'was skipped: game file is missing.' }], notFound: [{ mod: 'ModA', installationFiles: [], gameFiles: ['a.nif', 'b.nif'] }],
    });

    await commands.restoreFromManifest(['ModA']);

    expect(client.calls[1]?.args[0]).toMatchObject([{ unreadableGameFiles: { 'a.nif': 'the game folder was not found', 'b.nif': 'the game folder was not found' } }]);
  });

  it('sends a mod skipped for a submodule the call did not hand again, with where git checks it out, its pin and its branch, and answers both sends as one', async () => {
    const pinned = { folder: '/instance/source/Mod Source', pin: 'abc123', branch: 'main' };
    const { commands, client } = commandsOver({ pins: new Map([['Mod Source', pinned]]) });
    client.setCommandHandler('restoreFromManifest', (mods) => Promise.resolve(mods[0]?.submodule === undefined
      ? { landed: [], refused: [{ item: 'ModA', reason: SUBMODULE_MISSING }], notFound: [{ mod: 'ModA', installationFiles: [], submodule: 'Mod Source', gameFiles: [] }] }
      : RESTORED));

    const outcome = await commands.restoreFromManifest(['ModA']);

    expect(client.calls.map((call) => call.args[0])).toMatchObject([[{ name: 'ModA' }], [{ name: 'ModA', submodule: pinned }]]);
    expect(outcome).toEqual({ applied: true, landed: RESTORED.landed, refused: [] });
  });

  it('sends a source mod again with the downloaded files its manifest names once its submodule is handed, and answers all three sends as one', async () => {
    const pinned = { folder: '/instance/source/Mod Source', pin: 'abc123', branch: 'main' };
    const { commands, client } = commandsOver({ pins: new Map([['Mod Source', pinned]]), downloadedFiles: new Map([['ModA-1.0.7z', { kind: 'read', answer: INSTALLED }]]) });
    client.setCommandHandler('restoreFromManifest', (mods) => Promise.resolve(
      mods[0]?.submodule === undefined
        ? { landed: [], refused: [{ item: 'ModA', reason: SUBMODULE_MISSING }], notFound: [{ mod: 'ModA', installationFiles: [], submodule: 'Mod Source', gameFiles: [] }] }
        : (mods[0].installationFiles ?? []).length === 0
          ? { landed: [], refused: [{ item: 'ModA', reason: INSTALLATION_FILE_MISSING }], notFound: [{ mod: 'ModA', installationFiles: [{ name: 'ModA-1.0.7z', hash: 'H' }], gameFiles: [] }] }
          : RESTORED));

    const outcome = await commands.restoreFromManifest(['ModA']);

    expect(client.calls.map((call) => call.args[0])).toMatchObject([[{}], [{ submodule: pinned }], [{ submodule: pinned, installationFiles: [{ path: INSTALLED.path }] }]]);
    expect(outcome).toEqual({ applied: true, landed: RESTORED.landed, refused: [] });
  });

  it('hands mEdit why an installation file a source mod\'s manifest names could not be read, in the third send', async () => {
    const pinned = { folder: '/instance/source/Mod Source', pin: 'abc123', branch: 'main' };
    const { commands, client } = commandsOver({ pins: new Map([['Mod Source', pinned]]), downloadedFiles: new Map([['Pack.7z', { kind: 'unreadable', reason: 'EACCES' }]]) });
    client.setCommandHandler('restoreFromManifest', (mods) => Promise.resolve(
      mods[0]?.submodule === undefined
        ? { landed: [], refused: [{ item: 'ModA', reason: SUBMODULE_MISSING }], notFound: [{ mod: 'ModA', installationFiles: [], submodule: 'Mod Source', gameFiles: [] }] }
        : { landed: [], refused: [{ item: 'ModA', reason: INSTALLATION_FILE_MISSING }], notFound: [{ mod: 'ModA', installationFiles: [{ name: 'Pack.7z', hash: 'H' }], gameFiles: [] }] }));

    await commands.restoreFromManifest(['ModA']);

    expect(client.calls[2]?.args[0]).toMatchObject([{ installationFiles: [], unreadableInstallationFiles: { 'Pack.7z': 'EACCES' } }]);
  });

  it('says why beside a mod still skipped for a submodule the instance repository holds no pin for', async () => {
    const { commands, client } = commandsOver({ pins: new Map([['Mod Source', { lacks: 'the instance repository pins no commit at source/Mod Source' }]]) });
    client.setCommandResult('restoreFromManifest', {
      landed: [], refused: [{ item: 'ModA', reason: SUBMODULE_MISSING }], notFound: [{ mod: 'ModA', installationFiles: [], submodule: 'Mod Source', gameFiles: [] }],
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

    expect(adapter.calls.map(({ verb }) => verb).filter((verb) => verb !== 'writeModMetadata')).toEqual(['writePathTokens', 'trashFileIn', 'refuseUnpublishedPins']);
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
    client.setCommandHandler('restoreFromManifest', (mods) => Promise.resolve((mods[0]?.installationFiles ?? []).length === 0
      ? { landed: [], refused: [{ item: 'ModA', reason: INSTALLATION_FILE_MISSING }], notFound: [{ mod: 'ModA', installationFiles: [{ name: 'ModA-1.0.7z', hash: 'H' }], gameFiles: [] }] }
      : RESTORED));

    const outcome = await commands.restoreFromManifest(['ModA']);

    expect(client.calls.map((call) => call.args[0])).toMatchObject([[{}], [{ installationFiles: [INSTALLED] }]]);
    expect(outcome).toEqual({ applied: true, landed: RESTORED.landed, refused: [] });
  });

  it('hands mEdit why an installation file the Instance adapter could not read could not be read', async () => {
    const { commands, client } = commandsOver({ downloadedFiles: new Map([['ModA-1.0.7z', { kind: 'unreadable', reason: 'EACCES' }]]) });
    client.setCommandResult('restoreFromManifest', {
      landed: [], refused: [{ item: 'ModA', reason: INSTALLATION_FILE_MISSING }], notFound: [{ mod: 'ModA', installationFiles: [{ name: 'ModA-1.0.7z', hash: 'H' }], gameFiles: [] }],
    });

    await commands.restoreFromManifest(['ModA']);

    expect(client.calls[1]?.args[0]).toMatchObject([{ name: 'ModA', unreadableInstallationFiles: { 'ModA-1.0.7z': 'EACCES' } }]);
  });

  describe('an installation file the downloads folder lacks', () => {
    const LACKED: ManifestInstallationFile = { name: 'ModA-1.0.7z', hash: 'the bytes', page: FILE_78.page };
    const lackedUntilHanded = (client: InMemoryMEditClient, installationFile = LACKED): void => {
      client.setCommandHandler('restoreFromManifest', (mods) => Promise.resolve((mods[0]?.installationFiles ?? []).length === 0
        ? { landed: [], refused: [{ item: 'ModA', reason: INSTALLATION_FILE_MISSING }], notFound: [{ mod: 'ModA', installationFiles: [installationFile], gameFiles: [] }] }
        : RESTORED));
    };

    it('is downloaded from the page on Nexus its manifest names, put with what Nexus knows of it, and handed in the second send', async () => {
      const { nexus } = await nexusServing(servingFile78('the bytes'));
      const { commands, client, adapter } = commandsWired({ nexus });
      lackedUntilHanded(client);
      const heard: unknown[] = [];

      const outcome = await commands.restoreFromManifest(['ModA'], { onProgress: (status) => { heard.push(status); } });

      expect(adapter.calls).toContainEqual({ verb: 'putDownloadedFile', name: 'ModA-1.0.7z', info: expect.objectContaining({ game: 'fallout4', modID: '7', fileID: '78', name: 'Main' }) as unknown });
      expect(client.calls[1]?.args[0]).toMatchObject([{ installationFiles: [{ path: '/downloads/ModA-1.0.7z', hash: 'the bytes' }] }]);
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
        notFound: [{ mod: 'ModA', installationFiles: [LACKED], gameFiles: [] }, { mod: 'ModB', installationFiles: [{ ...LACKED, name: 'ModB.7z' }], gameFiles: [] }],
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
      return Promise.resolve({ landed: [], refused: [], notFound: [{ mod: 'ModA', installationFiles: [{ name: 'ModA-1.0.7z', hash: 'H' }], gameFiles: [] }] });
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
        notFound: [{ mod: 'ModB', installationFiles: [{ name: 'ModB.7z', hash: 'H' }], gameFiles: [] }],
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
    client.setCommandHandler('restoreFromManifest', (mods) => Promise.resolve((mods[0]?.installationFiles ?? []).length === 0
      ? { landed: [], refused: [], notFound: [{ mod: 'ModA', installationFiles: [{ name: 'ModA-1.0.7z', hash: 'H' }], gameFiles: [] }] }
      : { landed: [restoredMod({ mod: 'ModA', written: ['a.nif'] })], refused: [], notFound: [], cancelRefusal: 'Could not cancel — not running.' }));

    expect(await commands.restoreFromManifest(['ModA'])).toMatchObject({ cancelRefusal: 'Could not cancel — not running.' });
  });

  it('refuses a mod the Instance adapter cannot answer, naming why, and restores the rest', async () => {
    const { commands, client } = commandsWired({
      adapterOver: { modFolderPath: (mod) => Promise.resolve(mod === 'ModA' ? undefined : `/instance/mods/${mod}`) },
    });
    client.setCommandResult('restoreFromManifest', { landed: [restoredMod({ mod: 'ModB' })], refused: [], notFound: [] });

    const outcome = await commands.restoreFromManifest(['ModA', 'ModB']);

    expect([sentNames(client), outcome]).toEqual([
      [['ModB']], { applied: true, landed: [restoredMod({ mod: 'ModB' })], refused: [{ item: 'ModA', reason: 'its name gives it no folder' }] },
    ]);
  });

  describe('a folder outside the instance, shared or nested', () => {
    const OUTSIDE = "was skipped: its folder '/elsewhere/ModA' is outside the instance folder.";
    const REAL_FOLDER_CHECK: Partial<InstanceAdapter> = { foldersRefused: (folders, asked) => foldersRefused('/instance', folders, asked) };
    const SHARED_OUTPUT = { ModA: ['/source/A', '/source/B'] };

    it.each<[string, { folders: Record<string, string>; found?: OtherManifest[]; shared?: Record<string, readonly string[]>; sources?: Record<string, string>; asked?: string[] }, string[], { item: string; reason: string }[]]>([
      ['a folder outside the instance folder', { folders: { ModA: '/elsewhere/ModA', ModB: '/instance/mods/ModB' } }, ['ModB'], [{ item: 'ModA', reason: OUTSIDE }]],
      ['one folder built by two manifests', { folders: { ModA: '/instance/mods/Same', ModB: '/instance/mods/Same', ModC: '/instance/mods/ModC' } }, ['ModC'], [
        { item: 'ModA', reason: "was skipped: its folder is also built by 'ModB'." }, { item: 'ModB', reason: "was skipped: its folder is also built by 'ModA'." },
      ]],
      ['a selected mod built into the folder of a manifest that was not selected', { folders: { ModA: '/instance/Stock Game' }, found: [STOCK_GAME], asked: ['ModA'] }, [], [
        { item: 'ModA', reason: "was skipped: its folder is also built by 'Stock Game/'." },
      ]],
      ['one output built by two repositories', { folders: { ModA: '/instance/mods/ModA', ModB: '/instance/mods/ModB' }, shared: SHARED_OUTPUT }, ['ModB'], [
        { item: 'ModA', reason: "was skipped: the repositories '/source/A' and '/source/B' both build it." },
      ]],
      ['nothing of a source mod whose manifest spells its output as its folder does not', { folders: { Foo: '/instance/mods/Foo', foo: '/instance/mods/Foo' }, sources: { foo: '/source/foo' }, asked: ['Foo'] }, ['Foo'], []],
    ])('refuses %s and restores the rest', async (_name, { folders, found = [], shared = {}, sources = {}, asked }, sent, refused) => {
      const { commands, client } = commandsOver(
        { otherManifests: found }, new InMemoryMEditClient(), {}, { ...readingOf(), sourceMods: sourceModsOf(sources, [], [], {}, shared) },
        { adapterOver: { ...REAL_FOLDER_CHECK, modFolderPath: (mod) => Promise.resolve(folders[mod]) } },
      );
      client.setCommandHandler('restoreFromManifest', (mods) =>
        Promise.resolve({ landed: sentNamesOf(mods).map((mod) => restoredMod({ mod })), refused: [], notFound: [] }));

      const outcome = await commands.restoreFromManifest(asked ?? Object.keys(folders), {}, asked === undefined, asked === undefined ? found : []);

      expect({ sent: sentNames(client), refused: outcome.refused }).toEqual({ sent: sent.length === 0 ? [] : [sent], refused });
    });

    it('resolves every folder from the one listing of the mod folders it holds', async () => {
      const among: unknown[] = [];
      const { commands, client } = commandsOver({}, new InMemoryMEditClient(), {}, readingOf({}, FOUND, modFoldersOf('ModA', 'ModB')), {
        adapterOver: { modFolderPath: (mod, listing) => { among.push(listing); return Promise.resolve(`/instance/mods/${mod}`); } },
      });
      client.setCommandHandler('restoreFromManifest', () => Promise.resolve({ landed: [], refused: [], notFound: [] }));

      await commands.restoreFromManifest(['ModA', 'ModB']);

      expect([among.length > 0, new Set(among).size, among.includes(undefined)]).toEqual([true, 1, false]);
    });

    it('names a search for other manifests that failed, beside the mods of a selection', async () => {
      const { commands, client } = commandsOver({ unreadReads: { otherManifests: 'download_directory "%X%" could not be resolved' } });
      client.setCommandHandler('restoreFromManifest', () => Promise.resolve({ landed: [], refused: [], notFound: [] }));

      const outcome = await commands.restoreFromManifest(['ModA']);

      expect(outcome.refused).toEqual([{ item: 'every other manifest', reason: 'was not searched for: download_directory "%X%" could not be resolved' }]);
    });

    it('carries the refusals through a restore whose first call mEdit failed', async () => {
      const { commands, client } = commandsWired({ adapterOver: { ...REAL_FOLDER_CHECK, modFolderPath: (mod) => Promise.resolve(mod === 'ModA' ? '/elsewhere/ModA' : `/instance/mods/${mod}`) } });
      client.setCommandHandler('restoreFromManifest', () => Promise.resolve({ refused: true as const, message: 'Could not restore 1 mod — mEdit stopped.' }));

      expect(await commands.restoreFromManifest(['ModA', 'ModB'])).toEqual({
        applied: false, refusal: 'Could not restore 1 mod — mEdit stopped.', unfinished: ['ModB'], refused: [{ item: 'ModA', reason: OUTSIDE }],
      });
    });

    it('asks what restore destroys of none of them', async () => {
      const { commands, client } = commandsWired({ adapterOver: { ...REAL_FOLDER_CHECK, modFolderPath: () => Promise.resolve('/elsewhere/ModA') } });

      expect([await commands.whatRestoreDestroys(['ModA']), client.calls]).toEqual([{ destroys: [], refused: [{ item: 'ModA', reason: OUTSIDE }] }, []]);
    });
  });

  it('names every mod of a call that failed part way as not finished, since none had its files no line names trashed', async () => {
    const { commands, client } = commandsOver();
    client.setCommandHandler('restoreFromManifest', (_mods, _facts, options) => {
      options?.onProgress?.({ mod: 'ModA', modsDone: 0, modsTotal: 3 });
      options?.onProgress?.({ mod: 'ModB', modsDone: 1, modsTotal: 3 });
      return Promise.resolve({ refused: true, message: 'Could not restore 3 mods — mEdit stopped.' });
    });

    expect(await commands.restoreFromManifest(['ModA', 'ModB', 'ModC'])).toEqual({
      applied: false, refusal: 'Could not restore 3 mods — mEdit stopped.', unfinished: ['ModA', 'ModB', 'ModC'], refused: [],
    });
  });

  it('trashes the files no line names of each mod the first call landed when the second call fails, and names the second call\'s mods', async () => {
    const { commands, client, adapter } = commandsOver({ downloadedFiles: new Map([['ModB.7z', { kind: 'read', answer: INSTALLED }]]) });
    client.setCommandHandler('restoreFromManifest', (mods) => Promise.resolve(mods.length === 2
      ? { landed: [restoredMod({ mod: 'ModA', namedByNoLine: ['mine.txt'] })], refused: [], notFound: [{ mod: 'ModB', installationFiles: [{ name: 'ModB.7z', hash: 'H' }], gameFiles: [] }] }
      : { refused: true as const, message: 'Could not restore 1 mod — mEdit stopped.' }));

    const outcome = await commands.restoreFromManifest(['ModA', 'ModB']);

    expect([adapter.calls.filter(({ verb }) => verb === 'trashFileIn'), outcome]).toEqual([
      [{ verb: 'trashFileIn', folder: '/instance/mods/ModA', relativePath: 'mine.txt' }],
      { applied: false, refusal: 'Could not restore 1 mod — mEdit stopped.', unfinished: ['ModB'], refused: [] },
    ]);
  });

  it('sends each file no line names in a mod that landed to the trash, through the Instance adapter', async () => {
    const { commands, client, adapter } = commandsOver();
    client.setCommandResult('restoreFromManifest', { landed: [restoredMod({ mod: 'ModA', namedByNoLine: ['mine.txt', 'meshes/b.nif'] })], refused: [], notFound: [] });

    await commands.restoreFromManifest(['ModA']);

    expect(adapter.calls.filter(({ verb }) => verb === 'trashFileIn')).toEqual([
      { verb: 'trashFileIn', folder: '/instance/mods/ModA', relativePath: 'mine.txt' }, { verb: 'trashFileIn', folder: '/instance/mods/ModA', relativePath: 'meshes/b.nif' },
    ]);
  });

  describe('in mod order', () => {
    const winningFirst = ['ModA', 'ModB', 'ModC'].map((name) => ({ kind: 'mod', name, enabled: true }) as const);
    const steps = [{ task: 'Zip', args: [] }];

    function restoring(sources: Record<string, string>) {
      const log: string[] = [];
      const tasks = recordingTasks(['Zip']);
      const logging = { ...tasks, whyStepsFailed: (ran: readonly ManifestStep[], folder: string) => { log.push(`steps ${folder}`); return tasks.whyStepsFailed(ran, folder); } };
      const wired = commandsOver({}, new InMemoryMEditClient(), {}, { ...readingOf(sources), mods: [...winningFirst] }, { tasks: logging });
      wired.client.setCommandHandler('restoreFromManifest', (mods) => {
        const names = sentNamesOf(mods);
        log.push(`restore ${names.join(', ')}`);
        return Promise.resolve({ landed: names.map((mod) => restoredMod({ mod, steps })), refused: [], notFound: [] });
      });
      return { ...wired, log };
    }

    it('restores each source mod whole, its steps run, before it hands mEdit the next, from the losing end of mod order', async () => {
      const { commands, log } = restoring({ ModA: '/source/ModA', ModB: '/source/ModB' });

      const outcome = await commands.restoreFromManifest(['ModA', 'ModB']);

      expect(log).toEqual(['restore ModB', 'steps /instance/mods/ModB', 'restore ModA', 'steps /instance/mods/ModA']);
      expect(outcome).toMatchObject({ applied: true, landed: [{ mod: 'ModB' }, { mod: 'ModA' }] });
    });

    it('restores the run of mods that are not source mods between two source mods in one send, in mod order', async () => {
      const { commands, log } = restoring({ ModA: '/source/ModA', ModC: '/source/ModC' });

      await commands.restoreFromManifest(['ModA', 'ModB', 'ModC']);

      expect(log).toEqual(['restore ModC', 'steps /instance/mods/ModC', 'restore ModB', 'steps /instance/mods/ModB', 'restore ModA', 'steps /instance/mods/ModA']);
    });

    it('reports the mods that restored when a later send fails, and names the mods it did not finish', async () => {
      const { commands, client } = restoring({ ModA: '/source/ModA', ModB: '/source/ModB' });
      let sends = 0;
      client.setCommandHandler('restoreFromManifest', (mods) => {
        sends += 1;
        return Promise.resolve(sends === 1
          ? { landed: [restoredMod({ mod: sentNamesOf(mods)[0] ?? '' })], refused: [], notFound: [] }
          : { refused: true as const, message: 'mEdit stopped' });
      });

      const outcome = await commands.restoreFromManifest(['ModA', 'ModB']);

      expect(outcome).toMatchObject({ applied: true, landed: [{ mod: 'ModB' }], refused: [{ item: 'ModA', reason: expect.stringContaining('mEdit stopped') as unknown }] });
    });
  });

  describe('between mods', () => {
    const order = ['ModA', 'ModB', 'ModC'].map((name) => ({ kind: 'mod', name, enabled: true }) as const);
    const modCPlugin = { origin: { kind: 'mod', name: 'ModC' }, name: 'C.esp' } as const;
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });
    const restoring = () => {
      const wired = commandsOver({}, new InMemoryMEditClient(), {}, { ...readingOf({ ModA: '/source/ModA', ModC: '/source/ModC' }), mods: [...order], ...pluginFilesHeld(modCPlugin) });
      const sent: string[] = [];
      wired.client.setCommandHandler('restoreFromManifest', (mods) => {
        sent.push(...sentNamesOf(mods));
        return Promise.resolve({ landed: sentNamesOf(mods).map((mod) => restoredMod({ mod })), refused: [], notFound: [] });
      });
      return { ...wired, sent, asked: () => wired.client.calls.filter((call) => call.method === 'getPluginIndexing').map((call) => call.args[0]) };
    };

    it('hands mEdit the next source mod once the record index holds the plugins of the mod restored before it', async () => {
      const { commands, client, sent } = restoring();
      client.setQueryAnswer('getPluginIndexing', { state: 'NotYet' });

      const outcome = commands.restoreFromManifest(['ModA', 'ModC']);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sent).toEqual(['ModC']);
      client.setQueryAnswer('getPluginIndexing', { state: 'AsOnDisk' });
      client.emit(loadOrderStatusEventFixture());

      expect(await outcome).toMatchObject({ applied: true, landed: [{ mod: 'ModC' }, { mod: 'ModA' }] });
    });

    it('answers a mod whose plugin never reaches the record index with the reason, and restores the rest', async () => {
      const { commands, client, sent } = restoring();
      client.setQueryAnswer('getPluginIndexing', { state: 'NotYet' });

      const outcome = commands.restoreFromManifest(['ModA', 'ModB', 'ModC']);
      await vi.advanceTimersByTimeAsync(121_000);

      expect(sent).toEqual(['ModC', 'ModB', 'ModA']);
      expect(await outcome).toMatchObject({
        applied: true, landed: [{ mod: 'ModB' }, { mod: 'ModA' }],
        refused: [{ item: 'ModC', reason: 'was restored, but plugin C.esp did not reach the record index within 120 seconds' }],
      });
    });

    it('reads the instance once for every mod it waits on, and ends at once for a plugin mEdit failed to read', async () => {
      const unwaited = restoring();
      await unwaited.commands.restoreFromManifest(['ModA']);
      const wired = restoring();
      wired.client.setQueryAnswer('getPluginIndexing', { state: 'ReadFailed', reason: 'C.esp is not a plugin.' });

      const outcome = await wired.commands.restoreFromManifest(['ModA', 'ModB', 'ModC']);

      expect(wired.adapter.readings).toBe(unwaited.adapter.readings + 1);
      expect(outcome).toMatchObject({
        applied: true, landed: [{ mod: 'ModB' }, { mod: 'ModA' }],
        refused: [{ item: 'ModC', reason: 'was restored, but plugin C.esp could not be read: C.esp is not a plugin.' }],
      });
    });

    it('waits for no mod after the last, or before a mod that is not a source mod', async () => {
      const { commands, client, asked } = restoring();
      client.setQueryAnswer('getPluginIndexing', { state: 'NotYet' });

      const outcome = await commands.restoreFromManifest(['ModB', 'ModC']);

      expect(asked()).toEqual([]);
      expect(outcome).toMatchObject({ applied: true, landed: [{ mod: 'ModC' }, { mod: 'ModB' }], refused: [] });
    });

    it('stops waiting when the restore is cancelled, and names the mods it did not finish', async () => {
      const { commands, client } = restoring();
      client.setQueryAnswer('getPluginIndexing', { state: 'NotYet' });
      const cancel = new AbortController();

      const outcome = commands.restoreFromManifest(['ModA', 'ModC'], { signal: cancel.signal });
      await vi.advanceTimersByTimeAsync(1_000);
      cancel.abort();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(await outcome).toMatchObject({ applied: true, landed: [{ mod: 'ModC' }], refused: [{ item: 'ModA', reason: expect.stringContaining('cancelled') as unknown }] });
    });
  });

  it('runs the steps of a mod that landed in its folder, once its files no line names went to the trash', async () => {
    const tasks = recordingTasks(['Zip', 'Archive']);
    const order: string[] = [];
    const { commands, client } = commandsOver({}, new InMemoryMEditClient(), {}, readingOf(), {
      tasks: { ...tasks, whyStepsFailed: (steps, folder) => { order.push('ran its steps'); return tasks.whyStepsFailed(steps, folder); } },
      adapterOver: { trashFileIn: (_folder, path) => { order.push(`trashed ${path}`); return Promise.resolve(); } },
    });
    const steps = [{ task: 'Zip', args: ['a'] }, { task: 'Archive', args: [] }];
    client.setCommandResult('restoreFromManifest', { landed: [restoredMod({ mod: 'ModA', namedByNoLine: ['mine.txt'], steps })], refused: [], notFound: [] });

    const outcome = await commands.restoreFromManifest(['ModA']);

    expect(tasks.runs).toEqual([{ steps, folder: '/instance/mods/ModA' }]);
    expect(order).toEqual(['trashed mine.txt', 'ran its steps']);
    expect(outcome).toMatchObject({ applied: true, landed: [{ mod: 'ModA' }], refused: [] });
  });

  it('restores a folder outside the mod folders by its name: its files no line names to the trash and its steps in its folder, and no metadata', async () => {
    const tasks = recordingTasks(['Zip']);
    const { commands, client, adapter } = commandsOver(WHAT_A_MOD_MANAGER_WOULD_HOLD_OF_IT_AS_A_MOD, new InMemoryMEditClient(), {}, readingOf(), { tasks });
    const steps = [{ task: 'Zip', args: [] }];
    client.setCommandResult('restoreFromManifest', {
      landed: [restoredMod({ mod: 'Stock Game/', namedByNoLine: ['mine.txt'], steps, metadata: { version: '1' } })], refused: [], notFound: [],
    });

    const outcome = await commands.restoreFromManifest([], {}, false, [STOCK_GAME]);

    expect(client.calls[0]?.args[0]).toEqual([{ name: 'Stock Game/', folder: '/instance/Stock Game', metadataFiles: [] }]);
    expect(adapter.calls).toEqual([{ verb: 'writePathTokens' }, { verb: 'trashFileIn', folder: '/instance/Stock Game', relativePath: 'mine.txt' }]);
    expect(tasks.runs).toEqual([{ steps, folder: '/instance/Stock Game' }]);
    expect(outcome).toMatchObject({ applied: true, landed: [{ mod: 'Stock Game/' }], refused: [] });
  });

  it('answers a mod whose step failed as not finished, naming the step', async () => {
    const tasks = recordingTasks(['Zip'], { '/instance/mods/ModA': "step 'Zip' exited with code 1" });
    const { commands, client } = commandsOver({}, new InMemoryMEditClient(), {}, readingOf(), { tasks });
    client.setCommandResult('restoreFromManifest', { landed: [restoredMod({ mod: 'ModA', steps: [{ task: 'Zip', args: [] }] })], refused: [], notFound: [] });

    expect(await commands.restoreFromManifest(['ModA'])).toEqual({
      applied: true, landed: [],
      refused: [{ item: 'ModA', reason: "was not finished: its step 'Zip' exited with code 1. Restoring it again finishes it." }],
    });
  });

  it('answers a mod with a file the trash refused as not finished, naming the file and why', async () => {
    const { commands, client } = commandsOver({ refusals: refusing('trashFileIn', 'the trash is full') });
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
      { verb: 'writePathTokens' }, { verb: 'trashFileIn', folder: '/instance/mods/ModA', relativePath: 'mine.txt' }, { verb: 'writeModMetadata', mod: 'ModA', metadata },
    ]);
  });

  it('writes the metadata of a mod the second call landed, and of no mod that was skipped', async () => {
    const { commands, client, adapter } = commandsOver({ downloadedFiles: new Map([['ModA-1.0.7z', { kind: 'read', answer: INSTALLED }]]) });
    const metadata = { version: '2.0' };
    client.setCommandHandler('restoreFromManifest', (mods) => Promise.resolve(mods.length === 2
      ? { landed: [], refused: [{ item: 'ModA', reason: 'missing' }, { item: 'ModB', reason: "its package does not hold 'b.nif'" }], notFound: [{ mod: 'ModA', installationFiles: [{ name: 'ModA-1.0.7z', hash: 'H' }], gameFiles: [] }] }
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
      [{ method: 'getWhatRestoreDestroys', args: [[{ name: 'ModA', folder: '/instance/mods/ModA', metadataFiles: ['meta.ini'], metadata }], '/instance/stat-cache'] }],
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

  it('asks mEdit of a folder outside the mod folders by its name, with its folder and no metadata, and skips it for no metadata', async () => {
    const { commands, client } = commandsOver(WHAT_A_MOD_MANAGER_WOULD_HOLD_OF_IT_AS_A_MOD);
    const destroys = [{ mod: 'Stock Game/', differing: ['Fallout4.exe'], namedByNoLine: [], metadataDiffers: false }];
    client.setQueryAnswer('getWhatRestoreDestroys', { destroys, refused: [], manifests: [{ mod: 'Stock Game/', metadata: { version: '1' } }] });

    const listing = await commands.whatRestoreDestroys([], [STOCK_GAME]);

    expect([client.calls[0]?.args[0], listing]).toEqual([[{ name: 'Stock Game/', folder: '/instance/Stock Game', metadataFiles: [] }], { destroys, refused: [] }]);
  });

  it('refuses with mEdit\'s reason when it cannot answer', async () => {
    const { commands, client } = commandsOver();
    client.setQueryFailure('getWhatRestoreDestroys', { failed: 'unreachable' });

    expect(await commands.whatRestoreDestroys(['ModA'])).toEqual({ refusal: 'Could not ask what restore from manifest destroys: mEdit could not be reached.' });
  });
});

describe('modlistRepositoryCommands other manifests', () => {
  it('are the folders outside the mod folders the Instance adapter finds a manifest in, each folder it could not read refused', async () => {
    const { commands } = commandsOver({ otherManifests: [STOCK_GAME], unsearched: [{ name: 'logs/', reason: 'EACCES' }] });

    expect(await commands.otherManifests()).toEqual({
      others: [STOCK_GAME], refused: [{ item: 'logs/', reason: 'was not searched for a manifest: EACCES' }],
    });
  });

  it('are refused as one, naming why, when the instance could not be searched for them', async () => {
    const { commands } = commandsOver({ unreadReads: { otherManifests: 'download_directory "%X%" could not be resolved' } });

    expect(await commands.otherManifests()).toEqual({
      others: [], refused: [{ item: 'every other manifest', reason: 'was not searched for: download_directory "%X%" could not be resolved' }],
    });
  });
});

describe('modlistRepositoryCommands mod status', () => {
  const STATUS = [{ mod: 'ModA', noManifest: true, differing: [], namedByNoLine: [], gone: [], notInPackage: [], otherBytes: [], metadataDiffers: false, noHost: false }];

  it('asks mEdit for each mod\'s status by its folder, with its metadata files, the metadata the mod manager holds and the stat cache', async () => {
    const { commands, client } = commandsOver({ metadata: new Map([['ModA', { version: '1.2.3', installationFile: { name: 'A.7z', page: 'https://www.nexusmods.com/fallout4/mods/1' } }]]) });
    client.setQueryAnswer('getModStatus', STATUS);

    const answer = await commands.modStatus(['ModA']);

    expect([client.calls, answer]).toEqual([
      [{
        method: 'getModStatus',
        args: [[{
          name: 'ModA', folder: '/instance/mods/ModA', metadataFiles: ['meta.ini'],
          metadata: { version: '1.2.3', installationFile: { name: 'A.7z', page: 'https://www.nexusmods.com/fallout4/mods/1' } },
        }], '/instance/stat-cache'],
      }], STATUS,
    ]);
  });

  it('names a source mod\'s source folder, whose repository holds its manifest', async () => {
    const { commands, client } = commandsOver({}, new InMemoryMEditClient(), {}, readingOf({ ModA: '/source/Old ModA' }));
    client.setQueryAnswer('getModStatus', STATUS);

    await commands.modStatus(['ModA']);

    expect(client.calls).toMatchObject([{ method: 'getModStatus', args: [[{ name: 'ModA', sourceFolder: '/source/Old ModA' }], '/instance/stat-cache'] }]);
  });

  it('says why a mod\'s metadata could not be read, and sends none of it', async () => {
    const { commands, client } = commandsOver({ unreadableMetadata: new Map([['ModA', 'EACCES']]) });
    client.setQueryAnswer('getModStatus', STATUS);

    await commands.modStatus(['ModA']);

    expect(client.calls).toEqual([{
      method: 'getModStatus',
      args: [[{ name: 'ModA', folder: '/instance/mods/ModA', metadataFiles: ['meta.ini'], metadataUnreadable: 'EACCES' }], '/instance/stat-cache'],
    }]);
  });
});

const firstModSent = (client: InMemoryMEditClient): unknown => {
  const mods: unknown = client.calls[0]?.args[0];
  return Array.isArray(mods) ? (mods as readonly unknown[])[0] : undefined;
};

describe('modlistRepositoryCommands with another place of the game beside the game folder', () => {
  const GAME_PLACE: GamePlace = { root: '/game', depots: [], depotProblems: [] };
  const STEAM_PLACE: GamePlace = { root: '/steam', depots: [], depotProblems: [] };
  const UPDATED = { landed: [{ mod: 'ModB', manifestWritten: true, notInPackage: [], otherBytes: [] }], refused: [] };
  type Places = NonNullable<InstanceAnswers['places']>;
  const besideHolding = (files: [string, string][], unreadable: [string, string][] = [], place: Partial<GamePlace> = {}): Places => [
    GAME_PLACE,
    {
      ...STEAM_PLACE,
      ...place,
      gameFiles: new Map(files.map(([path, hash]) => [path.toLowerCase(), { path, hash }])),
      unreadableGameFiles: new Map(unreadable),
      gameFilesTaken: new Map([['ModB', { kind: 'read', answer: { gameFiles: files.map(([path, hash]) => ({ path, hash })), notes: [] } }]]),
    },
  ];
  const skippedForGameFile = (path: string) => ({
    landed: [], refused: [{ item: 'ModA', reason: 'was skipped: game file is missing.' }], notFound: [{ mod: 'ModA', installationFiles: [], gameFiles: [path] }],
  });

  it('hands update manifest the files of another place as another place', async () => {
    const { commands, client } = commandsOver({ places: besideHolding([['Meshes/B.nif', '#b']]) });
    client.setCommandResult('updateManifest', UPDATED);

    await commands.updateManifest(['ModB']);

    expect(firstModSent(client)).toMatchObject({ gameFolder: { ...GAME_FOLDER, elsewhere: [{ root: '/steam', files: [{ path: 'Meshes/B.nif', hash: '#b' }] }] } });
  });

  it('hands update manifest the depots of a place on that place', async () => {
    const depots = [{ id: '377162', version: '2222' }];
    const { commands, client } = commandsOver({ places: besideHolding([['Meshes/B.nif', '#b']], [], { depots }) });
    client.setCommandResult('updateManifest', UPDATED);

    await commands.updateManifest(['ModB']);

    const sent = firstModSent(client);
    expect(sent).toMatchObject({ gameFolder: { elsewhere: [{ root: '/steam', depots }] } });
    expect(sent).not.toHaveProperty('gameFolder.depots');
  });

  it('hands update manifest the depots of the game folder place on the game folder', async () => {
    const depots = [{ id: '377162', version: '2222' }];
    const { commands, client } = commandsOver({ places: [{ ...GAME_PLACE, depots }] });
    client.setCommandResult('updateManifest', UPDATED);

    await commands.updateManifest(['ModB']);

    expect(firstModSent(client)).toMatchObject({ gameFolder: { depots } });
  });

  it('notes on the update why a place gave fewer depots than it holds', async () => {
    const depotProblems = ['appmanifest_377160.acf records no installed depot'];
    const { commands, client } = commandsOver({ places: besideHolding([['Meshes/B.nif', '#b']], [], { depotProblems }) });
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModB']);

    expect(outcome).toMatchObject({ applied: true, repositoryNotes: depotProblems });
  });

  it('notes no depot problem when no mod of the update takes a file from the game', async () => {
    const { commands, client } = commandsOver({ places: besideHolding([], [], { depotProblems: ['appmanifest_377160.acf records no installed depot'] }) });
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModB']);

    expect(outcome).toMatchObject({ applied: true, repositoryNotes: [] });
  });

  it('hands restore no depots, which its manifest names', async () => {
    const { commands, client } = commandsOver({ places: besideHolding([['Meshes/A.nif', '#a']], [], { depots: [{ id: '377162', version: '2222' }] }) });
    client.setCommandResult('restoreFromManifest', skippedForGameFile('meshes/a.nif'));

    await commands.restoreFromManifest(['ModA']);

    expect(client.calls[1]?.args[1]).not.toHaveProperty('gameFolder.elsewhere.0.depots');
  });

  it('hands restore\'s retry the files of another place as another place', async () => {
    const { commands, client } = commandsOver({ places: besideHolding([['Meshes/A.nif', '#a']]) });
    client.setCommandResult('restoreFromManifest', skippedForGameFile('meshes/a.nif'));

    await commands.restoreFromManifest(['ModA']);

    expect(client.calls[1]?.args[1]).toMatchObject({ gameFolder: { ...GAME_FOLDER, elsewhere: [{ root: '/steam', files: [{ path: 'Meshes/A.nif', hash: '#a' }] }] } });
  });

  it('hands mEdit why a file of another place could not be read, so it is not shown as missing', async () => {
    const { commands, client } = commandsOver({ places: besideHolding([], [['meshes/a.nif', 'EACCES']]) });
    client.setCommandResult('restoreFromManifest', skippedForGameFile('meshes/a.nif'));

    await commands.restoreFromManifest(['ModA']);

    expect(client.calls[1]?.args[0]).toMatchObject([{ unreadableGameFiles: { 'meshes/a.nif': 'EACCES' } }]);
  });

  it('does not refuse a mod the game folder holds when another place cannot be read, and notes which place', async () => {
    const taken: FileRead<{ gameFiles: { path: string; hash: string }[]; notes: string[] }> =
      { kind: 'read', answer: { gameFiles: [{ path: 'Meshes/B.nif', hash: '#b' }], notes: [] } };
    const { commands, client } = commandsOver({
      places: [
        { ...GAME_PLACE, gameFilesTaken: new Map([['ModB', taken]]) },
        { ...STEAM_PLACE, gameFilesTaken: new Map([['ModB', { kind: 'unreadable', reason: 'EACCES' }]]) },
      ],
    });
    client.setCommandResult('updateManifest', UPDATED);

    const outcome = await commands.updateManifest(['ModB']);

    expect(firstModSent(client)).toMatchObject({ gameFolder: { files: [{ path: 'Meshes/B.nif', hash: '#b' }] } });
    expect(outcome).toMatchObject({ refused: [], notes: [{ mod: 'ModB', note: 'the game files in /steam could not be read: EACCES' }] });
  });
});
