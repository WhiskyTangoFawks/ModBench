import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { FileRead, FoundGameFolder, GameFolder, GamePlace, HashedFile, InstallationFile, InstanceReading } from '../../instanceAdapter/instanceAdapter';
import { textHash } from '../../instanceAdapter/fileContents/contentDigest';
import { pinText, writeManifestIn, type Manifest, type ManifestFile, type ManifestPackage } from '../../manifestAdapter/manifestAdapter';
import { manifestText } from '../../manifestAdapter/manifestText';
import type { Nexus } from '../../nexus/nexus';
import { answeringFrom, FILE_78, nexusAnswering, nexusServing, servingFile78 } from '../../nexus/test/nexusDouble';
import { fakeInstanceAdapter, modFoldersIn, pluginFilesHeld, readingFixture, refusing, sourceModsOf, type AdapterCall, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { loadOrderStatusEventFixture } from '../../client/test/fixtures';
import { GAME_FOLDER_NOT_FOUND } from '../../test/mo2/gameFolderNotFound';
import { recordingTasks } from '../../test/recordingTasks';
import { restoreFromManifest, whatRestoreDestroys, type RestoreStatus } from '../restoreFromManifest';

const EMPTY: Manifest = { packages: [], exclude: [], archives: [], steps: [], tools: [], files: [] };
const MOD_7Z: ManifestPackage = { kind: 'installationFile', name: 'ModA.7z', size: 10, hash: 'H' };
const DOWNLOADED: InstallationFile = {
  path: '/downloads/ModA.7z', size: 10, hash: 'H', entries: [{ path: 'a.nif', hash: 'HA' }, { path: 'b.nif', hash: 'HB' }, { path: 'Data/c.nif', hash: 'HC' }],
};
const FOUND: FoundGameFolder = { kind: 'found', root: '/game', dataFolder: '/game/Data' };
const GAME_PLACE: GamePlace = { root: '/game', holdsDataFiles: true, depots: [], depotProblems: [] };
const STEAM_PLACE: GamePlace = { root: '/steam', holdsDataFiles: true, depots: [], depotProblems: [] };
const NOT_FINISHED = 'was not finished: the restore was cancelled. Restoring it again finishes it.';

const held = (path: string, inPackage?: string, pkg?: string): ManifestFile =>
  ({ path, entry: inPackage === undefined ? { kind: 'held' } : { kind: 'heldAt', path: inPackage }, ...(pkg === undefined ? {} : { package: pkg }) });
const fromTheZip = (...files: ManifestFile[]): Manifest => ({ ...EMPTY, packages: [MOD_7Z], files });
const read = <T>(answer: T): FileRead<T> => ({ kind: 'read', answer });
const gameFiles = (...files: [string, string][]) => new Map(files.map(([path, hash]) => [path.toLowerCase(), { path, hash }]));
const pinOf = (...taken: { path: string; hash: string }[]): Promise<string> => textHash(pinText(taken));

let root: string;
let modsDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'restoreFromManifest-'));
  modsDir = join(root, 'mods');
  await mkdir(modsDir);
});
afterEach(() => rm(root, { recursive: true, force: true }));

interface Setup {
  readonly files?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly manifests?: Readonly<Record<string, Manifest>>;
  readonly answers?: InstanceAnswers;
  readonly sourceFolders?: Record<string, string>;
  readonly shared?: Record<string, readonly string[]>;
  readonly reading?: Partial<InstanceReading>;
  readonly gameFolder?: GameFolder;
  readonly tasks?: readonly string[];
  readonly failures?: Readonly<Record<string, string>>;
  readonly nexus?: Nexus;
}

async function over({ files = {}, manifests = {}, answers = {}, sourceFolders = {}, shared = {}, reading = {}, gameFolder = FOUND, tasks = [], failures = {}, nexus }: Setup = {}) {
  const mods = [...new Set([...Object.keys(files), ...Object.keys(manifests)])];
  for (const mod of mods) await mkdir(join(modsDir, mod), { recursive: true });
  for (const [mod, manifest] of Object.entries(manifests)) await writeManifestIn(join(modsDir, mod), manifest);
  const hashes = new Map<string, HashedFile>(Object.entries(files).flatMap(([mod, inFolder]) =>
    Object.entries(inFolder).map(([path, hash]) => [join(modsDir, mod, path), { size: 1, hash }] as const)));
  const fake = fakeInstanceAdapter(
    readingFixture({ gameFolder, sourceMods: sourceModsOf(sourceFolders, [], [], {}, shared), modFolders: modFoldersIn(modsDir, ...mods), ...reading }),
    { folderFiles: new Map(Object.entries(files).map(([mod, inFolder]) => [join(modsDir, mod), Object.keys(inFolder)])), hashes, ...answers });
  const client = new InMemoryMEditClient();
  const steps = recordingTasks(tasks, failures);
  const deps = { client, adapter: fake.adapter, nexus: nexus ?? nexusAnswering(answeringFrom({})).nexus, trash: () => Promise.resolve(), tasks: steps };
  return {
    fake, client, hashes, steps, deps,
    restore: (asked: readonly string[], options: Parameters<typeof restoreFromManifest>[2] = {}) => restoreFromManifest(deps, asked, options, false, []),
    destroys: (asked: readonly string[]) => whatRestoreDestroys(deps, asked, []),
  };
}

const folderOf = (mod: string): string => join(modsDir, mod);

const writes = (calls: readonly AdapterCall[]): AdapterCall[] =>
  calls.filter(({ verb }) => ['writeFilesIn', 'trashFileIn', 'writeModMetadata', 'keepPackageEntries'].includes(verb));

describe('restore from manifest', () => {
  it('writes each file whose bytes differ or that is gone from its package, sends each file no line names to the trash, then writes the metadata its manifest holds', async () => {
    const { restore, fake } = await over({
      files: { ModA: { 'a.nif': 'HA', 'b.nif': 'edited', 'mine.txt': 'M' } },
      manifests: { ModA: { ...fromTheZip(held('a.nif'), held('b.nif'), held('c.nif', 'Data/c.nif')), version: '1.0' } },
      answers: { downloadedFiles: new Map([['ModA.7z', read(DOWNLOADED)]]) },
    });

    const outcome = await restore(['ModA']);

    const entry = (path: string) => ({ kind: 'entry', downloadedFile: '/downloads/ModA.7z', entry: path });
    expect(writes(fake.calls)).toEqual([
      { verb: 'writeFilesIn', folder: folderOf('ModA'), files: [{ path: 'b.nif', from: entry('b.nif') }, { path: 'c.nif', from: entry('Data/c.nif') }] },
      { verb: 'trashFileIn', folder: folderOf('ModA'), relativePath: 'mine.txt' },
      { verb: 'writeModMetadata', mod: 'ModA', metadata: { version: '1.0', installationFile: { name: 'ModA.7z' } } },
    ]);
    expect(outcome).toEqual({ landed: [{ mod: 'ModA', written: ['b.nif', 'c.nif'], namedByNoLine: ['mine.txt'] }], refused: [] });
  });

  it('writes no file of a folder whose bytes are all its manifest\'s', async () => {
    const { restore, fake } = await over({
      files: { ModA: { 'a.nif': 'HA' } }, manifests: { ModA: fromTheZip(held('a.nif')) }, answers: { downloadedFiles: new Map([['ModA.7z', read(DOWNLOADED)]]) },
    });

    const outcome = await restore(['ModA']);

    expect([fake.calls.some(({ verb }) => verb === 'writeFilesIn'), outcome.landed]).toEqual([false, [{ mod: 'ModA', written: [], namedByNoLine: [] }]]);
  });

  describe('from the game folder', () => {
    async function takingFromTheGame(answers: InstanceAnswers) {
      const pin = await pinOf({ path: 'a.nif', hash: '#a' });
      const manifest: Manifest = { ...EMPTY, packages: [{ kind: 'gameFolder', name: 'Fallout4', hash: pin, depots: [] }], files: [held('a.nif', 'Data/a.nif')] };
      return { pin, ...await over({ manifests: { ModA: manifest }, answers }) };
    }

    it('writes a game file with the bytes its pin fixes, and keeps the package\'s entries for a status to read', async () => {
      const { pin, restore, fake } = await takingFromTheGame({ places: [{ ...GAME_PLACE, gameFiles: gameFiles(['Data/A.nif', '#a']) }] });

      await restore(['ModA']);

      expect(writes(fake.calls).slice(0, 2)).toEqual([
        { verb: 'writeFilesIn', folder: folderOf('ModA'), files: [{ path: 'a.nif', from: { kind: 'gameFile', root: '/game', path: 'Data/A.nif' } }] },
        { verb: 'keepPackageEntries', hash: pin, entries: new Map([['Data/a.nif', '#a']]) },
      ]);
    });

    it('takes it from another place of the game when the game folder holds it with other bytes', async () => {
      const { restore, fake } = await takingFromTheGame({
        places: [{ ...GAME_PLACE, gameFiles: gameFiles(['Data/a.nif', '#other']) }, { ...STEAM_PLACE, gameFiles: gameFiles(['Data/a.nif', '#a']) }],
      });

      await restore(['ModA']);

      expect(writes(fake.calls)[0]).toMatchObject({ files: [{ from: { root: '/steam' } }] });
    });

    it('lands, naming in a note why the hash index could not keep the package\'s entries', async () => {
      const { restore } = await takingFromTheGame({ places: [{ ...GAME_PLACE, gameFiles: gameFiles(['Data/a.nif', '#a']) }], packageEntriesNotWritten: 'ENOSPC' });

      expect((await restore(['ModA'])).landed).toEqual([{
        mod: 'ModA', written: ['a.nif'], namedByNoLine: [], notes: ['the files it takes from the game folder could not be recorded, so its status reads them as differing: ENOSPC'],
      }]);
    });
  });

  it.each<[string, Setup, string]>([
    ['its installation file is missing, and its manifest names no file on Nexus',
      { manifests: { ModA: fromTheZip(held('a.nif')) } },
      "was skipped: installation file 'ModA.7z' is missing. Its manifest names no file on Nexus to download it from."],
    ['its installation file has other bytes',
      { manifests: { ModA: fromTheZip(held('a.nif')) }, answers: { downloadedFiles: new Map([['ModA.7z', read({ ...DOWNLOADED, hash: 'X' })]]) } },
      "was skipped: installation file 'ModA.7z' has other bytes."],
    ['its installation file cannot be read',
      { manifests: { ModA: fromTheZip(held('a.nif')) }, answers: { downloadedFiles: new Map([['ModA.7z', { kind: 'unreadable', reason: 'EACCES' }]]) } },
      "was skipped: installation file 'ModA.7z' could not be read: EACCES."],
    ['its installation file holds no entry a line names',
      { manifests: { ModA: fromTheZip(held('z.nif')) }, answers: { downloadedFiles: new Map([['ModA.7z', read(DOWNLOADED)]]) } },
      "was skipped: installation file 'ModA.7z' holds no 'z.nif'."],
    ['no package holds a file',
      { manifests: { ModA: { ...EMPTY, files: [{ path: 'mine.txt', entry: { kind: 'notHeld' } }] } } },
      "was skipped: its package does not hold 'mine.txt'."],
    ['a package holds a file with other bytes',
      { manifests: { ModA: { ...fromTheZip(), files: [{ path: 'a.nif', entry: { kind: 'otherBytes' } }] } }, answers: { downloadedFiles: new Map([['ModA.7z', read(DOWNLOADED)]]) } },
      "was skipped: its package holds 'a.nif' with other bytes."],
    ['a line names no package',
      { manifests: { ModA: { ...EMPTY, files: [held('a.nif')] } } },
      "was skipped: 'a.nif' names no installation file."],
    ['no game folder holds a game file, naming the depots that hold it',
      { manifests: { ModA: { ...EMPTY, packages: [{ kind: 'gameFolder', name: 'Fallout4', hash: 'pin', depots: [{ id: '377162', version: '2222' }] }], files: [held('a.nif', 'Data/a.nif')] } } },
      "was skipped: game file 'Data/a.nif' is missing; the game folder 'Fallout4' is depot 377162 at version 2222."],
    ['the game folder was not found',
      { manifests: { ModA: { ...EMPTY, packages: [{ kind: 'gameFolder', name: 'Fallout4', hash: 'pin', depots: [] }], files: [held('a.nif', 'Data/a.nif')] } }, gameFolder: GAME_FOLDER_NOT_FOUND },
      "was skipped: game file 'Data/a.nif' could not be read: the game folder was not found."],
    ['the game files it takes have other bytes than its pin fixes',
      {
        manifests: { ModA: { ...EMPTY, packages: [{ kind: 'gameFolder', name: 'Fallout4', hash: 'pin', depots: [] }], files: [held('a.nif', 'Data/a.nif')] } },
        answers: { gameFiles: gameFiles(['Data/a.nif', '#a']) },
      },
      "was skipped: the files it takes from the game folder 'Fallout4' have other bytes."],
    ['this machine has no task for a tool its steps run',
      { manifests: { ModA: { ...EMPTY, steps: [{ task: 'Optimise', args: [] }], tools: [{ task: 'Optimise', page: 'https://tools.example/optimise' }] } } },
      "was skipped: this machine has no task for its tool 'Optimise' (https://tools.example/optimise)."],
    ['its package has no host',
      { manifests: { ModA: { ...EMPTY, packages: [{ kind: 'sourceRepository', name: 'ModA', isSubmodule: false }] } } },
      'was skipped: its package has no host.'],
    ['its manifest names another output folder',
      { manifests: { ModA: { ...EMPTY, output: 'Elsewhere' } } },
      "was skipped: its manifest names the output folder 'Elsewhere', not its folder 'ModA'."],
    ['it has no manifest', { files: { ModA: { 'a.nif': 'HA' } } }, 'was skipped: it has no manifest.'],
  ])('skips a mod, writing nothing, when %s', async (_case, setup, reason) => {
    const { restore, fake } = await over(setup);

    const outcome = await restore(['ModA']);

    expect([outcome, writes(fake.calls)]).toEqual([{ landed: [], refused: [{ item: 'ModA', reason }] }, []]);
  });

  it('skips a mod whose manifest cannot be read, naming where', async () => {
    const { restore } = await over({ files: { ModA: {} } });
    await writeFile(join(folderOf('ModA'), 'ModA.manifest.json'), '{');

    expect((await restore(['ModA'])).refused).toEqual([{ item: 'ModA', reason: 'was skipped: its manifest cannot be read at line 1.' }]);
  });

  it.each<[string, InstanceAnswers['refusals'], string]>([
    ['a file could not be written', refusing('writeFilesIn', 'EROFS'), 'was not finished: EROFS. Restoring it again finishes it.'],
    ['the trash refused a file', refusing('trashFileIn', 'EBUSY'), "was not finished: 'mine.txt' could not be moved to the trash: EBUSY. Restoring it again finishes it."],
    ['its metadata could not be written', refusing('writeModMetadata', 'locked'), 'was not finished: its metadata could not be written: locked. Restoring it again finishes it.'],
  ])('names a mod not finished when %s', async (_case, refusals, reason) => {
    const { restore } = await over({
      files: { ModA: { 'b.nif': 'edited', 'mine.txt': 'M' } }, manifests: { ModA: fromTheZip(held('b.nif')) },
      answers: { downloadedFiles: new Map([['ModA.7z', read(DOWNLOADED)]]), refusals },
    });

    expect(await restore(['ModA'])).toEqual({ landed: [], refused: [{ item: 'ModA', reason }] });
  });

  it('runs a mod\'s steps in its folder once its files and metadata are written, and names it not finished when a step fails', async () => {
    const steps = [{ task: 'Optimise', args: ['--in', 'textures'] }];
    const { restore, steps: tasks } = await over({
      manifests: { ModA: { ...EMPTY, steps }, ModB: { ...EMPTY, steps } }, tasks: ['Optimise'], failures: { [join(modsDir, 'ModB')]: "step 'Optimise' exited with code 1" },
    });

    const outcome = await restore(['ModA', 'ModB']);

    expect(tasks.runs).toEqual([{ steps, folder: folderOf('ModA') }, { steps, folder: folderOf('ModB') }]);
    expect(outcome).toEqual({
      landed: [{ mod: 'ModA', written: [], namedByNoLine: [] }],
      refused: [{ item: 'ModB', reason: "was not finished: its step 'Optimise' exited with code 1. Restoring it again finishes it." }],
    });
  });

  it('restores a folder outside the mod folders by its name, and writes no metadata', async () => {
    const stock = join(root, 'Stock Game');
    await mkdir(stock);
    await writeManifestIn(stock, { ...EMPTY, version: '1' });
    const { deps, fake } = await over();

    const outcome = await restoreFromManifest(deps, [], {}, false, [{ name: 'Stock Game/', folder: stock }]);

    expect([outcome.landed, writes(fake.calls)]).toEqual([[{ mod: 'Stock Game/', written: [], namedByNoLine: [] }], []]);
  });

  it('names each mod a cancel stopped before as not finished, writing nothing of it', async () => {
    const cancel = new AbortController();
    const { restore, fake } = await over({ manifests: { ModA: EMPTY, ModB: EMPTY } });

    const outcome = await restore(['ModA', 'ModB'], { onProgress: (status) => { if (status.phase === 'Restoring') cancel.abort(); }, signal: cancel.signal });

    expect([outcome.landed.map(({ mod }) => mod), outcome.refused, writes(fake.calls)]).toEqual([['ModA'], [{ item: 'ModB', reason: NOT_FINISHED }], [{ verb: 'writeModMetadata', mod: 'ModA', metadata: {} }]]);
  });

  it('reports each mod it restores, from the losing end of mod order', async () => {
    const heard: RestoreStatus[] = [];
    const { restore } = await over({ manifests: { ModA: EMPTY, ModB: EMPTY } });

    await restore(['ModB', 'ModA'], { onProgress: (status) => { heard.push(status); } });

    expect(heard).toEqual([{ phase: 'Restoring', mod: 'ModB', modsDone: 0, modsTotal: 2 }, { phase: 'Restoring', mod: 'ModA', modsDone: 1, modsTotal: 2 }]);
  });

  it('writes the path tokens before it reads a mod, and makes the repository refuse a push of a pin its remote lacks once the mods landed', async () => {
    const { restore, fake } = await over({ manifests: { ModA: EMPTY }, answers: { repositoryOnDisk: true, pathTokenLeft: 'ModOrganizer.ini still holds a path token' } });

    const outcome = await restore(['ModA']);

    expect(fake.calls.map(({ verb }) => verb)).toEqual(['writePathTokens', 'writeModMetadata', 'refuseUnpublishedPins']);
    expect(outcome.pathTokensNotWritten).toBe('ModOrganizer.ini still holds a path token');
  });

  it('names why the push refusal could not be written beside the mods that landed', async () => {
    const { restore } = await over({ manifests: { ModA: EMPTY }, answers: { repositoryOnDisk: true, refusals: refusing('refuseUnpublishedPins', 'a hook is there') } });

    expect(await restore(['ModA'])).toEqual({ landed: [{ mod: 'ModA', written: [], namedByNoLine: [] }], refused: [], pushRefusalNotWritten: 'a hook is there' });
  });

  describe('an installation file the downloads folder lacks', () => {
    const manifests = { ModA: { ...EMPTY, packages: [{ ...MOD_7Z, hash: 'the bytes', page: FILE_78.page }] } };

    it('is downloaded from the page on Nexus its manifest names, put with what Nexus knows of it, and the mod restored from it', async () => {
      const { nexus } = await nexusServing(servingFile78('the bytes'));
      const { restore, fake } = await over({ manifests, nexus });
      const heard: RestoreStatus[] = [];

      const outcome = await restore(['ModA'], { onProgress: (status) => { heard.push(status); } });

      expect(fake.calls).toContainEqual({ verb: 'putDownloadedFile', name: 'ModA.7z', info: expect.objectContaining({ game: 'fallout4', modID: '7', fileID: '78', name: 'Main' }) as unknown });
      expect(heard).toContainEqual({ phase: 'Downloading', file: 'ModA.7z' });
      expect(outcome.landed).toEqual([{ mod: 'ModA', written: [], namedByNoLine: [] }]);
    });

    it.each([
      ['Nexus does not send it, as while logged out', 'the bytes', false, {}, ' It could not be downloaded from Nexus: You are not logged in to Nexus.'],
      ['Nexus sends another file than its manifest names', 'other bytes', true, {}, ' It could not be downloaded from Nexus: the file Nexus sent is not the one its manifest names.'],
      ['the Instance adapter cannot put it', 'the bytes', true, { refusals: refusing('putDownloadedFile', 'ENOSPC') }, ' It could not be downloaded from Nexus: ENOSPC.'],
    ])('skips the mod when %s, naming why', async (_case, bytes, loggedIn, answers, why) => {
      const { nexus } = await nexusServing(servingFile78(bytes), loggedIn);
      const { restore } = await over({ manifests, nexus, answers });

      expect((await restore(['ModA'])).refused).toEqual([{ item: 'ModA', reason: `was skipped: installation file 'ModA.7z' is missing.${why}` }]);
    });

    it('lets the server\'s connection go when the Instance adapter refuses the file before it reads it', async () => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; } });
      const { nexus } = await nexusServing({ ...servingFile78('the bytes'), [FILE_78.server]: new Response(body) });
      const { restore } = await over({ manifests, nexus, answers: { refusals: refusing('putDownloadedFile', 'ENOSPC') } });

      await restore(['ModA']);

      expect(cancelled).toBe(true);
    });

    it('asks Nexus nothing for an installation file the downloads folder holds', async () => {
      const { nexus, sent } = await nexusServing(servingFile78('the bytes'));
      const { restore } = await over({ manifests, nexus, answers: { downloadedFiles: new Map([['ModA.7z', read({ ...DOWNLOADED, hash: 'the bytes' })]]) } });

      await restore(['ModA']);

      expect(sent).toEqual([]);
    });

    it('downloads nothing for the next mod once a cancel aborts its signal', async () => {
      const cancel = new AbortController();
      const { nexus, sent } = await nexusServing({ ...servingFile78('the bytes'), [FILE_78.record]: new Response('', { status: 404 }) });
      const { restore } = await over({ manifests: { ...manifests, ModB: manifests.ModA }, nexus });

      const outcome = await restore(['ModA', 'ModB'], { onProgress: (status) => { if (status.phase === 'Downloading') cancel.abort(); }, signal: cancel.signal });

      expect([sent.map(({ url }) => url), outcome.refused.at(-1)]).toEqual([[FILE_78.record], { item: 'ModB', reason: NOT_FINISHED }]);
    });
  });

  describe('a source mod with a remote', () => {
    const source = (): string => join(root, 'source', 'ModA');
    const pinned = (): { folder: string; pin: string; branch: string } => ({ folder: source(), pin: 'abc', branch: 'main' });
    const BUILT = { mod: 'ModA', compiled: [], refused: [], archivesRefused: [], overwritten: [], made: [{ path: 'a.esp', vouchedFor: true }] };

    async function sourceMod(answers: InstanceAnswers = {}) {
      await mkdir(source(), { recursive: true });
      const manifest: Manifest = {
        ...EMPTY, output: 'ModA', packages: [{ kind: 'sourceRepository', name: 'ModA', isSubmodule: true }, MOD_7Z], files: [held('a.esp'), held('b.nif', undefined, 'ModA.7z')],
      };
      await writeFile(join(source(), 'ModA.manifest.json'), manifestText(manifest));
      const setup = await over({
        files: { ModA: { 'a.esp': 'old', 'b.nif': 'HB', 'mine.txt': 'M' } }, sourceFolders: { ModA: source() },
        answers: { downloadedFiles: new Map([['ModA.7z', read(DOWNLOADED)]]), pins: new Map([['ModA', pinned()]]), ...answers },
      });
      setup.client.setCommandResult('cloneSubmodules', { applied: [{ folder: source(), leftDetached: "its branch 'main' is at def" }], refused: [] });
      setup.client.setCommandHandler('build', () => {
        setup.hashes.set(join(folderOf('ModA'), 'a.esp'), { size: 1, hash: 'compiled' });
        return Promise.resolve({ landed: [BUILT], refused: [] });
      });
      return setup;
    }

    it('is built by mEdit at the commit the instance repository pins, with the installation files its manifest names, and its files no line names sent to the trash', async () => {
      const { restore, client, fake } = await sourceMod();

      const outcome = await restore(['ModA']);

      expect(client.calls.map(({ method, args }) => [method, args[0]])).toEqual([
        ['cloneSubmodules', [pinned()]],
        ['build', [{ name: 'ModA', sourceFolder: source(), folder: folderOf('ModA'), exclude: [], taken: ['b.nif'], archives: [] }]],
      ]);
      expect(writes(fake.calls)).toMatchObject([
        { verb: 'keepPackageEntries', hash: 'ModA', entries: new Map([['a.esp', 'compiled']]) }, { verb: 'trashFileIn' }, { verb: 'writeModMetadata' },
      ]);
      expect(outcome).toEqual({ landed: [{ mod: 'ModA', written: ['a.esp'], namedByNoLine: ['mine.txt'], leftDetached: "its branch 'main' is at def" }], refused: [] });
    });

    it('is skipped, naming the commit, and not built when its submodule is at another commit', async () => {
      const { restore, client } = await sourceMod();
      const another = 'its submodule is at def, not at abc, the commit the instance repository pins';
      client.setCommandResult('cloneSubmodules', { applied: [], refused: [{ item: source(), refusal: 'AtAnotherCommit', message: another }] });

      const outcome = await restore(['ModA']);

      expect([outcome.refused, client.calls.map(({ method }) => method)]).toEqual([[{ item: 'ModA', reason: `was skipped: ${another}.` }], ['cloneSubmodules']]);
    });

    it('is skipped, naming why, when its submodule could not be cloned', async () => {
      const { restore, client } = await sourceMod();
      client.setCommandResult('cloneSubmodules', { applied: [], refused: [{ item: source(), refusal: 'NotCloned', message: 'its remote holds no commit abc' }] });

      expect((await restore(['ModA'])).refused).toEqual([{ item: 'ModA', reason: 'was skipped: its submodule could not be cloned or read: its remote holds no commit abc.' }]);
    });

    it('is skipped, naming what the instance repository lacks, when it pins no commit for its submodule', async () => {
      const { restore } = await sourceMod({ pins: new Map([['ModA', { lacks: 'the instance repository pins no commit at source/ModA' }]]) });

      expect((await restore(['ModA'])).refused).toEqual([{ item: 'ModA', reason: "was skipped: its submodule 'ModA' is missing. The instance repository pins no commit at source/ModA." }]);
    });

    it('is not finished when its build left a plugin as it was', async () => {
      const { restore, client } = await sourceMod();
      client.setCommandHandler('build', () => Promise.resolve({ landed: [{ ...BUILT, refused: [{ item: { name: 'A.esp', origin: 'ModA' }, reason: 'A.esp was not compiled: it holds an error.' }] }], refused: [] }));

      expect((await restore(['ModA'])).refused).toEqual([{ item: 'ModA', reason: 'was not finished: A.esp was not compiled: it holds an error.' }]);
    });

    it('is skipped with its build\'s reason when the build refused it', async () => {
      const { restore, client } = await sourceMod();
      client.setCommandHandler('build', () => Promise.resolve({ landed: [], refused: [{ item: 'ModA', reason: 'was not built: no load order is held.' }] }));

      expect((await restore(['ModA'])).refused).toEqual([{ item: 'ModA', reason: 'was not built: no load order is held.' }]);
    });
  });

  it('skips a mod two repositories both build, writing nothing', async () => {
    const { restore, fake } = await over({ manifests: { ModA: EMPTY }, shared: { ModA: ['/instance/source/A', '/instance/source/B'] } });

    const outcome = await restore(['ModA']);

    expect([outcome, writes(fake.calls)]).toEqual([
      { landed: [], refused: [{ item: 'ModA', reason: "was skipped: the repositories '/instance/source/A' and '/instance/source/B' both build it." }] }, [],
    ]);
  });

  describe('before a source mod', () => {
    const MODS = ['ModA', 'ModB', 'ModC'].map((name) => ({ kind: 'mod', name, enabled: true }) as const);
    const C_ESP = { origin: { kind: 'mod', name: 'ModC' }, name: 'C.esp' } as const;
    beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); });
    afterEach(() => { vi.useRealTimers(); });

    async function aSourceModAfterTwoMods() {
      const source = join(root, 'source', 'ModA');
      await mkdir(source, { recursive: true });
      await writeFile(join(source, 'ModA.manifest.json'), manifestText({ ...EMPTY, output: 'ModA' }));
      return over({ manifests: { ModA: EMPTY, ModB: EMPTY, ModC: EMPTY }, sourceFolders: { ModA: source }, reading: { mods: [...MODS], ...pluginFilesHeld(C_ESP) } });
    }

    const waiting = (client: InMemoryMEditClient) => vi.waitFor(() => { expect(client.calls.map(({ method }) => method)).toContain('getPluginIndexing'); });

    it('waits until the record index holds the plugins of each mod restored before it', async () => {
      const { restore, client } = await aSourceModAfterTwoMods();
      client.setQueryAnswer('getPluginIndexing', { state: 'NotYet' });
      let ended = false;

      const outcome = restore(['ModA', 'ModB', 'ModC']).finally(() => { ended = true; });
      await waiting(client);
      await vi.advanceTimersByTimeAsync(1_000);
      const endedBeforeIndexed = ended;
      client.setQueryAnswer('getPluginIndexing', { state: 'AsOnDisk' });
      client.emit(loadOrderStatusEventFixture());

      expect([endedBeforeIndexed, (await outcome).landed.map(({ mod }) => mod)]).toEqual([false, ['ModC', 'ModB', 'ModA']]);
    });

    it.each([
      ['never reaches the record index', { state: 'NotYet' } as const, 121_000, 'was restored, but plugin C.esp did not reach the record index within 120 seconds'],
      ['could not be read by mEdit', { state: 'ReadFailed', reason: 'C.esp is not a plugin.' } as const, 0, 'was restored, but plugin C.esp could not be read: C.esp is not a plugin.'],
    ])('names a mod whose plugin %s, and restores the source mod after it', async (_case, indexing, wait, reason) => {
      const { restore, client } = await aSourceModAfterTwoMods();
      client.setQueryAnswer('getPluginIndexing', indexing);

      const outcome = restore(['ModA', 'ModB', 'ModC']);
      await waiting(client);
      await vi.advanceTimersByTimeAsync(wait);

      expect(await outcome).toEqual({
        landed: [{ mod: 'ModB', written: [], namedByNoLine: [] }, { mod: 'ModA', written: [], namedByNoLine: [] }], refused: [{ item: 'ModC', reason }],
      });
    });

    it('waits on no mod before a mod that is not a source mod', async () => {
      const { restore, client } = await aSourceModAfterTwoMods();
      client.setQueryAnswer('getPluginIndexing', { state: 'NotYet' });

      const outcome = await restore(['ModB', 'ModC']);

      expect([client.calls.filter(({ method }) => method === 'getPluginIndexing'), outcome.refused]).toEqual([[], []]);
    });
  });

  it('clones each submodule the source folder lacks first, naming each it could not clone or whose pin the instance repository lacks', async () => {
    const uncloned = { name: 'Mod Source', folder: '/instance/source/Mod Source', pin: 'abc', branch: 'main' };
    const { restore, client } = await over({ answers: { uncloned: [uncloned, { name: 'Other', lacks: 'its pin is gone' }] } });
    client.setCommandResult('cloneSubmodules', { applied: [], refused: [{ item: uncloned.folder, refusal: 'NotCloned', message: 'its remote holds no commit abc' }] });

    const outcome = await restore([]);

    expect([client.calls[0]?.args[0], outcome.refused]).toEqual([[{ folder: uncloned.folder, pin: 'abc', branch: 'main' }], [
      { item: 'Other', reason: 'was not cloned: its pin is gone.' }, { item: 'Mod Source', reason: 'was not cloned: its remote holds no commit abc.' },
    ]]);
  });
});

describe('what restore from manifest destroys', () => {
  it('is each file whose bytes differ from what the installation file the downloads folder holds fixes, each file no line names, and metadata it overwrites', async () => {
    const { destroys } = await over({
      files: { ModA: { 'a.nif': 'HA', 'b.nif': 'edited', 'mine.txt': 'M' }, ModB: { 'a.nif': 'HA' } },
      manifests: { ModA: { ...fromTheZip(held('a.nif'), held('b.nif')), version: '1.0' }, ModB: fromTheZip(held('a.nif')) },
      answers: { downloadedFiles: new Map([['ModA.7z', read(DOWNLOADED)]]), metadata: new Map([['ModA', { version: '0.9' }]]) },
    });

    expect(await destroys(['ModA', 'ModB'])).toEqual({ destroys: [{ mod: 'ModA', differing: ['b.nif'], namedByNoLine: ['mine.txt'], metadataDiffers: true }], refused: [] });
  });

  it('is nothing after a fresh clone, whose folders hold no file the manifests name and no metadata', async () => {
    const { destroys } = await over({ files: { ModA: {} }, manifests: { ModA: { ...fromTheZip(held('a.nif')), version: '1.0' } } });

    expect(await destroys(['ModA'])).toEqual({ destroys: [], refused: [] });
  });

  it.each<[string, InstanceAnswers, string]>([
    ['its metadata cannot be read', { unreadableMetadata: new Map([['ModA', 'locked']]) }, 'was skipped: its metadata could not be read: locked.'],
    ['its metadata cannot hold what its manifest says', { unwritableMetadata: new Map([['ModA', 'its metadata names another game']]) }, 'was skipped: its metadata names another game.'],
  ])('skips a mod when %s', async (_case, answers, reason) => {
    const { destroys } = await over({ manifests: { ModA: fromTheZip() }, answers });

    expect(await destroys(['ModA'])).toEqual({ destroys: [], refused: [{ item: 'ModA', reason }] });
  });
});
