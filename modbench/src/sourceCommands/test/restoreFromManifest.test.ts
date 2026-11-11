import { ORDER_SENT } from '../../test/orderSent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { FileRead, FoundGameFolder, GameFolder, HashedFile, InstallationFile, InstanceReading } from '../../instanceAdapter/instanceAdapter';
import { writeManifestIn, type Manifest, type ManifestPackage } from '../../manifestAdapter/manifestAdapter';
import { buildFileOf, writeBuildFile } from '../../test/buildFiles';
import type { Nexus } from '../../nexus/nexus';
import { answeringFrom, FILE_78, nexusAnswering, nexusServing, servingFile78 } from '../../nexus/test/nexusDouble';
import { fakeInstanceAdapter, modFoldersIn, pluginFilesHeld, readingFixture, refusing, repositoriesOf, type AdapterCall, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { loadOrderStatusEventFixture } from '../../client/test/fixtures';
import { GAME_FOLDER_NOT_FOUND } from '../../test/mo2/gameFolderNotFound';
import { recordingTasks } from '../../test/recordingTasks';
import { restoreFromManifest, type RestoreStatus } from '../restoreFromManifest';

const HA = 'AAAAAAAAAAA=';
const HB = 'BBBBBBBBBBA=';
const HC = 'CCCCCCCCCCA=';
const EDITED = 'EEEEEEEEEEA=';
const PACK = 'PPPPPPPPPPA=';
const EMPTY: Manifest = { packages: [], exclude: [], ignore: [], flags: new Map(), files: new Map() };
const MOD_7Z = { kind: 'installationFile', name: 'ModA.7z', size: 10, hash: PACK } as const;
const DOWNLOADED: InstallationFile = {
  path: '/downloads/ModA.7z', size: 10, hash: PACK, entries: [{ path: 'a.nif', hash: HA }, { path: 'b.nif', hash: HB }, { path: 'Data/c.nif', hash: HC }],
};
const REPOSITORY: ManifestPackage = { kind: 'repository', name: 'ModA' };
const FOUND: FoundGameFolder = { kind: 'found', root: '/game', dataFolder: '/game/Data' };
const NOT_FINISHED = 'was not finished: the restore was cancelled. Restoring it again finishes it.';

const holding = (files: Record<string, string | null>): Manifest['files'] => new Map(Object.entries(files));
const fromTheZip = (files: Record<string, string>, over: Partial<Manifest> = {}): Manifest => ({ ...EMPTY, packages: [MOD_7Z], files: holding(files), ...over });
const read = <T>(answer: T): FileRead<T> => ({ kind: 'read', answer });
const takenFromTheGame = (...files: [string, string, string][]): InstanceAnswers['gameFilesTaken'] =>
  new Map([['ModA', read({ gameFiles: files.map(([path, hash, pathInFolder]) => ({ path, hash, pathInFolder })), notes: [] })]]);

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
  readonly reading?: Partial<InstanceReading>;
  readonly gameFolder?: GameFolder;
  readonly tasks?: readonly string[];
  readonly failures?: Readonly<Record<string, string>>;
  readonly nexus?: Nexus;
  readonly foldersOutsideMods?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

async function over({ files = {}, manifests = {}, answers = {}, sourceFolders = {}, reading = {}, gameFolder = FOUND, tasks = [], failures = {}, nexus, foldersOutsideMods = {} }: Setup = {}) {
  const mods = [...new Set([...Object.keys(files), ...Object.keys(manifests)])];
  for (const mod of mods) await mkdir(join(modsDir, mod), { recursive: true });
  for (const [mod, manifest] of Object.entries(manifests)) await writeManifestIn(join(modsDir, mod), manifest);
  const inFolders = [...Object.entries(files).map(([mod, inFolder]) => [join(modsDir, mod), inFolder] as const), ...Object.entries(foldersOutsideMods)];
  const hashes = new Map<string, HashedFile>(inFolders.flatMap(([folder, inFolder]) =>
    Object.entries(inFolder).map(([path, hash]) => [join(folder, path), { size: 1, hash }] as const)));
  const fake = fakeInstanceAdapter(
    readingFixture({ gameFolder, sourceModFolders: repositoriesOf(sourceFolders), modFolders: modFoldersIn(modsDir, ...mods), ...reading }),
    { folderFiles: new Map(inFolders.map(([folder, inFolder]) => [folder, Object.keys(inFolder)])), hashes, ...answers });
  const client = new InMemoryMEditClient();
  const steps = recordingTasks(tasks, failures);
  const deps = { client, adapter: fake.adapter, nexus: nexus ?? nexusAnswering(answeringFrom({})).nexus, trash: () => Promise.resolve(), loadOrderSnapshot: ORDER_SENT, tasks: steps };
  return {
    fake, client, hashes, steps, deps,
    restore: (asked: readonly string[], options: Parameters<typeof restoreFromManifest>[2] = {}) => restoreFromManifest(deps, asked, options, false, []),
  };
}

const folderOf = (mod: string): string => join(modsDir, mod);

const writes = (calls: readonly AdapterCall[]): AdapterCall[] =>
  calls.filter(({ verb }) => ['writeFilesIn', 'trashFileIn', 'writeInstalledFrom'].includes(verb));

describe('restore from manifest', () => {
  const heldWholeSetup = () => over({
    files: { ModA: { 'a.nif': EDITED }, ModB: { 'a.nif': EDITED } },
    manifests: { ModA: fromTheZip({ 'a.nif': HA }), ModB: fromTheZip({ 'a.nif': HA }) },
    answers: { downloadedFiles: new Map([['ModA.7z', read(DOWNLOADED)]]), heldWholeByGit: new Set([folderOf('ModA')]) },
  });

  it('refuses a mod whose whole folder git holds and leaves its files alone, since no manifest records the rest of it', async () => {
    const { restore, fake } = await heldWholeSetup();

    const outcome = await restore(['ModA', 'ModB']);

    expect([outcome.refused, outcome.landed.map(({ mod }) => mod)]).toEqual([[{ item: 'ModA', reason: 'was skipped: git holds its whole folder.' }], ['ModB']]);
    expect(writes(fake.calls)).not.toEqual([]);
    expect(JSON.stringify(writes(fake.calls))).not.toContain(folderOf('ModA'));
  });

  it('passes over a mod whose whole folder git holds when it runs on every manifest, refusing none', async () => {
    const { deps } = await heldWholeSetup();

    const outcome = await restoreFromManifest(deps, ['ModA', 'ModB'], {}, true, []);

    expect([outcome.refused, outcome.landed.map(({ mod }) => mod)]).toEqual([[], ['ModB']]);
  });

  it('writes each file whose bytes differ or that is gone from the entry of its bytes, wherever its package holds it, and sends each file it does not name to the trash', async () => {
    const { restore, fake } = await over({
      files: { ModA: { 'a.nif': HA, 'b.nif': EDITED, 'mine.txt': 'M' } },
      manifests: { ModA: fromTheZip({ 'a.nif': HA, 'b.nif': HB, 'c.nif': HC }) },
      answers: { downloadedFiles: new Map([['ModA.7z', read(DOWNLOADED)]]) },
    });

    const outcome = await restore(['ModA']);

    const entry = (path: string) => ({ kind: 'entry', downloadedFile: '/downloads/ModA.7z', entry: path });
    expect(writes(fake.calls)).toEqual([
      { verb: 'writeFilesIn', folder: folderOf('ModA'), files: [{ path: 'b.nif', from: entry('b.nif') }, { path: 'c.nif', from: entry('Data/c.nif') }] },
      { verb: 'trashFileIn', folder: folderOf('ModA'), relativePath: 'mine.txt' },
      { verb: 'writeInstalledFrom', folder: folderOf('ModA'), packages: [{ name: 'ModA.7z' }] },
    ]);
    expect(outcome).toEqual({ landed: [{ mod: 'ModA', written: ['b.nif', 'c.nif'], namedByNoLine: ['mine.txt'] }], refused: [] });
  });

  it('sends to the trash no file git holds in a mod\'s folder, which its manifest does not name (The manifest, story 5)', async () => {
    const { restore, fake } = await over({
      files: { ModA: { 'a.nif': HA, 'config.ini': 'C' } },
      manifests: { ModA: fromTheZip({ 'a.nif': HA }) },
      answers: { downloadedFiles: new Map([['ModA.7z', read(DOWNLOADED)]]), heldByGit: new Map([[folderOf('ModA'), ['config.ini']]]) },
    });

    const outcome = await restore(['ModA']);

    expect([writes(fake.calls), outcome.landed]).toEqual([
      [{ verb: 'writeInstalledFrom', folder: folderOf('ModA'), packages: [{ name: 'ModA.7z' }] }], [{ mod: 'ModA', written: [], namedByNoLine: [] }],
    ]);
  });

  it('writes and sends to the trash nothing of a file its manifest ignores, whatever its bytes (The manifest, story 11)', async () => {
    const { restore, fake } = await over({
      files: { ModA: { 'a.nif': HA, 'Game.mem': EDITED, 'logs/run.log': 'L' } },
      manifests: { ModA: fromTheZip({ 'a.nif': HA }, { ignore: ['Game.mem', 'logs'] }) },
      answers: { downloadedFiles: new Map([['ModA.7z', read(DOWNLOADED)]]) },
    });

    const outcome = await restore(['ModA']);

    expect(writes(fake.calls)).toEqual([{ verb: 'writeInstalledFrom', folder: folderOf('ModA'), packages: [{ name: 'ModA.7z' }] }]);
    expect(outcome).toEqual({ landed: [{ mod: 'ModA', written: [], namedByNoLine: [] }], refused: [] });
  });

  it('names every installation file of a mod to the metadata, in the order the manifest reads them', async () => {
    const second = { ...MOD_7Z, name: 'ModA-patch.7z' };
    const { restore, fake } = await over({
      files: { ModA: { 'a.nif': HA } }, manifests: { ModA: fromTheZip({ 'a.nif': HA }, { packages: [MOD_7Z, second] }) },
      answers: { downloadedFiles: new Map([['ModA.7z', read(DOWNLOADED)], ['ModA-patch.7z', read({ ...DOWNLOADED, path: '/downloads/ModA-patch.7z' })]]) },
    });

    await restore(['ModA']);

    expect(writes(fake.calls)).toEqual([{ verb: 'writeInstalledFrom', folder: folderOf('ModA'), packages: [{ name: 'ModA-patch.7z' }, { name: 'ModA.7z' }] }]);
  });

  it('hands the metadata the version each installation file of the manifest names', async () => {
    const second = { ...MOD_7Z, name: 'ModA-patch.7z' };
    const { restore, fake } = await over({
      files: { ModA: { 'a.nif': HA } }, manifests: { ModA: fromTheZip({ 'a.nif': HA }, { packages: [{ ...MOD_7Z, packageVersion: '1.0' }, second] }) },
      answers: { downloadedFiles: new Map([['ModA.7z', read(DOWNLOADED)], ['ModA-patch.7z', read({ ...DOWNLOADED, path: '/downloads/ModA-patch.7z' })]]) },
    });

    await restore(['ModA']);

    expect(writes(fake.calls)).toEqual([{ verb: 'writeInstalledFrom', folder: folderOf('ModA'), packages: [{ name: 'ModA-patch.7z' }, { name: 'ModA.7z', version: '1.0' }] }]);
  });

  it('refuses a mod whose metadata could not be written, as not finished', async () => {
    const { restore } = await over({
      files: { ModA: { 'a.nif': HA } }, manifests: { ModA: fromTheZip({ 'a.nif': HA }) },
      answers: { downloadedFiles: new Map([['ModA.7z', read(DOWNLOADED)]]), refusals: refusing('writeInstalledFrom', 'EROFS') },
    });

    expect((await restore(['ModA'])).refused).toEqual([{ item: 'ModA', reason: 'was not finished: EROFS. Restoring it again finishes it.' }]);
  });

  it('writes a file its manifest excludes under the mod manager\'s mark, moving the file the folder holds included', async () => {
    const { restore, fake } = await over({
      files: { ModA: { 'b.nif': HB } }, manifests: { ModA: fromTheZip({ 'b.nif': HB }, { exclude: ['b.nif'] }) },
      answers: { downloadedFiles: new Map([['ModA.7z', read(DOWNLOADED)]]) },
    });

    await restore(['ModA']);

    expect(writes(fake.calls)).toEqual([
      { verb: 'writeFilesIn', folder: folderOf('ModA'), files: [{ path: 'b.nif.mohidden', from: { kind: 'entry', downloadedFile: '/downloads/ModA.7z', entry: 'b.nif' } }] },
      { verb: 'trashFileIn', folder: folderOf('ModA'), relativePath: 'b.nif' },
      { verb: 'writeInstalledFrom', folder: folderOf('ModA'), packages: [{ name: 'ModA.7z' }] },
    ]);
  });

  it('writes no file of a folder whose bytes are all its manifest\'s', async () => {
    const { restore, fake } = await over({
      files: { ModA: { 'a.nif': HA } }, manifests: { ModA: fromTheZip({ 'a.nif': HA }) }, answers: { downloadedFiles: new Map([['ModA.7z', read(DOWNLOADED)]]) },
    });

    const outcome = await restore(['ModA']);

    expect([fake.calls.some(({ verb }) => verb === 'writeFilesIn'), outcome.landed]).toEqual([false, [{ mod: 'ModA', written: [], namedByNoLine: [] }]]);
  });

  describe('from the game folder', () => {
    const takingFromTheGame = (answers: InstanceAnswers) =>
      over({ manifests: { ModA: { ...EMPTY, packages: [{ kind: 'gameFolder' }], files: holding({ 'a.nif': HA }) } }, answers });

    it('writes the game file the folder\'s file may be, with the bytes its manifest records', async () => {
      const { restore, fake } = await takingFromTheGame({ gameFilesTaken: takenFromTheGame(['Data/A.nif', HA, 'a.nif']) });

      await restore(['ModA']);

      expect(writes(fake.calls)).toEqual([
        { verb: 'writeFilesIn', folder: folderOf('ModA'), files: [{ path: 'a.nif', from: { kind: 'gameFile', root: '/game', path: 'Data/A.nif' } }] },
      ]);
    });
  });

  it.each<[string, Setup, string]>([
    ['its installation file is missing, and its manifest names no file on Nexus',
      { manifests: { ModA: fromTheZip({ 'a.nif': HA }) } },
      "was skipped: installation file 'ModA.7z' is missing. Its manifest names no file on Nexus to download it from."],
    ['its installation file is missing, and its manifest names an address',
      { manifests: { ModA: fromTheZip({ 'a.nif': HA }, { packages: [{ ...MOD_7Z, host: { url: 'https://f4se.silverlock.org/beta/f4se_0_06_23.7z' } }] }) } },
      "was skipped: installation file 'ModA.7z' is missing. Its manifest names https://f4se.silverlock.org/beta/f4se_0_06_23.7z to download it from by hand."],
    ['its installation file has other bytes',
      { manifests: { ModA: fromTheZip({ 'a.nif': HA }) }, answers: { downloadedFiles: new Map([['ModA.7z', read({ ...DOWNLOADED, hash: EDITED })]]) } },
      "was skipped: installation file 'ModA.7z' has other bytes."],
    ['its installation file cannot be read',
      { manifests: { ModA: fromTheZip({ 'a.nif': HA }) }, answers: { downloadedFiles: new Map([['ModA.7z', { kind: 'unreadable', reason: 'EACCES' }]]) } },
      "was skipped: installation file 'ModA.7z' could not be read: EACCES."],
    ['no package it names holds the bytes of a file',
      { manifests: { ModA: fromTheZip({ 'z.nif': EDITED }) }, answers: { downloadedFiles: new Map([['ModA.7z', read(DOWNLOADED)]]) } },
      "was skipped: no package it names holds the bytes of 'z.nif'."],
    ['it names no package',
      { manifests: { ModA: { ...EMPTY, files: holding({ 'mine.txt': HA }) } } },
      "was skipped: no package it names holds the bytes of 'mine.txt'."],
    ['the game folder holds no game file with its bytes, naming the depots of its package',
      { manifests: { ModA: { ...EMPTY, packages: [{ kind: 'gameFolder', host: { steam: { app: 377160, depots: { 377162: '2222' } } } }], files: holding({ 'a.nif': HA }) } } },
      "was skipped: no package it names holds the bytes of 'a.nif'; its game folder package names depot 377162 at version 2222."],
    ['the game folder was not found',
      { manifests: { ModA: { ...EMPTY, packages: [{ kind: 'gameFolder' }], files: holding({ 'a.nif': HA }) } }, gameFolder: GAME_FOLDER_NOT_FOUND },
      'was skipped: the game folder was not found.'],
    ['its repository is not in the source folder and is no submodule',
      { manifests: { ModA: { ...EMPTY, packages: [REPOSITORY] } } },
      "was skipped: the source folder holds no repository 'ModA', and no answer fixed for ModA."],
    ['its submodule is not cloned',
      { manifests: { ModA: { ...EMPTY, packages: [REPOSITORY] } }, answers: { pins: new Map([['ModA', { folder: '/source/ModA', pin: 'abc' }]]) } },
      "was skipped: its submodule 'ModA' is not cloned."],
    ['it has no manifest', { files: { ModA: { 'a.nif': HA } } }, 'was skipped: it has no manifest.'],
    ['a path its manifest names carries the mod manager\'s mark for an excluded file',
      { files: { ModA: {} }, manifests: { ModA: fromTheZip({ 'a.nif.mohidden': HA }) }, answers: { downloadedFiles: new Map([['ModA.7z', read(DOWNLOADED)]]) } },
      "was skipped: its manifest names 'a.nif.mohidden', which carries the mod manager's mark for an excluded file."],
  ])('skips a mod, writing nothing, when %s', async (_case, setup, reason) => {
    const { restore, fake } = await over(setup);

    const outcome = await restore(['ModA']);

    expect([outcome, writes(fake.calls)]).toEqual([{ landed: [], refused: [{ item: 'ModA', reason }] }, []]);
  });

  it('skips a mod whose manifest is of the format before version 1, naming both versions', async () => {
    const { restore } = await over({ files: { ModA: {} } });
    await writeFile(join(folderOf('ModA'), 'ModA.manifest.json'), '{\n"files": []\n}\n');

    expect((await restore(['ModA'])).refused).toEqual([{ item: 'ModA', reason: "was skipped: its manifest is in a format before version 1, and Modbench reads only version 1." }]);
  });

  it('skips a mod whose manifest cannot be read, naming where', async () => {
    const { restore } = await over({ files: { ModA: {} } });
    await writeFile(join(folderOf('ModA'), 'ModA.manifest.json'), '{');

    expect((await restore(['ModA'])).refused).toEqual([{ item: 'ModA', reason: "was skipped: its manifest is not valid JSON at line 1: Expected property name or '}' in JSON at position 1." }]);
  });

  it.each<[string, InstanceAnswers['refusals'], string]>([
    ['a file could not be written', refusing('writeFilesIn', 'EROFS'), 'was not finished: EROFS. Restoring it again finishes it.'],
    ['the trash refused a file', refusing('trashFileIn', 'EBUSY'), "was not finished: 'mine.txt' could not be moved to the trash: EBUSY. Restoring it again finishes it."],
  ])('names a mod not finished when %s', async (_case, refusals, reason) => {
    const { restore } = await over({
      files: { ModA: { 'b.nif': EDITED, 'mine.txt': 'M' } }, manifests: { ModA: fromTheZip({ 'b.nif': HB }) },
      answers: { downloadedFiles: new Map([['ModA.7z', read(DOWNLOADED)]]), refusals },
    });

    expect(await restore(['ModA'])).toEqual({ landed: [], refused: [{ item: 'ModA', reason }] });
  });

  it('restores a folder outside the mod folders by its name, and writes no metadata', async () => {
    const stock = join(root, 'Stock Game');
    await mkdir(stock);
    await writeManifestIn(stock, EMPTY);
    const { deps, fake } = await over();

    const outcome = await restoreFromManifest(deps, [], {}, false, [{ name: 'Stock Game/', folder: stock }]);

    expect([outcome.landed, writes(fake.calls)]).toEqual([[{ mod: 'Stock Game/', written: [], namedByNoLine: [] }], []]);
  });

  it('names each mod a cancel stopped before as not finished, writing nothing of it', async () => {
    const cancel = new AbortController();
    const { restore, fake } = await over({ manifests: { ModA: EMPTY, ModB: EMPTY } });

    const outcome = await restore(['ModA', 'ModB'], { onProgress: (status) => { if (status.phase === 'Restoring') cancel.abort(); }, signal: cancel.signal });

    expect([outcome.landed.map(({ mod }) => mod), outcome.refused, writes(fake.calls)]).toEqual([['ModA'], [{ item: 'ModB', reason: NOT_FINISHED }], []]);
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

    expect(fake.calls.map(({ verb }) => verb)).toEqual(['writePathTokens', 'refuseUnpublishedPins']);
    expect(outcome.pathTokensNotWritten).toBe('ModOrganizer.ini still holds a path token');
  });

  it('names why the push refusal could not be written beside the mods that landed', async () => {
    const { restore } = await over({ manifests: { ModA: EMPTY }, answers: { repositoryOnDisk: true, refusals: refusing('refuseUnpublishedPins', 'a hook is there') } });

    expect(await restore(['ModA'])).toEqual({ landed: [{ mod: 'ModA', written: [], namedByNoLine: [] }], refused: [], pushRefusalNotWritten: 'a hook is there' });
  });

  describe('an installation file the downloads folder lacks', () => {
    const manifests = { ModA: { ...EMPTY, packages: [{ ...MOD_7Z, host: { nexus: { game: 'fallout4', mod: 7, file: 78 } } }] } };

    it('is downloaded from the page on Nexus its manifest names, put with what Nexus knows of it, and the mod restored from it', async () => {
      const { nexus } = await nexusServing(servingFile78(PACK));
      const { restore, fake } = await over({ manifests, nexus });
      const heard: RestoreStatus[] = [];

      const outcome = await restore(['ModA'], { onProgress: (status) => { heard.push(status); } });

      expect(fake.calls).toContainEqual({ verb: 'putDownloadedFile', name: 'ModA.7z', info: expect.objectContaining({ game: 'fallout4', modID: '7', fileID: '78', name: 'Main' }) as unknown });
      expect(heard).toContainEqual({ phase: 'Downloading', file: 'ModA.7z' });
      expect(outcome.landed).toEqual([{ mod: 'ModA', written: [], namedByNoLine: [] }]);
    });

    it.each([
      ['Nexus does not send it, as while logged out', PACK, false, {}, ' It could not be downloaded from Nexus: You are not logged in to Nexus.'],
      ['Nexus sends another file than its manifest names', EDITED, true, {}, ' It could not be downloaded from Nexus: the file Nexus sent is not the one its manifest names.'],
      ['the Instance adapter cannot put it', PACK, true, { refusals: refusing('putDownloadedFile', 'ENOSPC') }, ' It could not be downloaded from Nexus: ENOSPC.'],
    ])('skips the mod when %s, naming why', async (_case, bytes, loggedIn, answers, why) => {
      const { nexus } = await nexusServing(servingFile78(bytes), loggedIn);
      const { restore } = await over({ manifests, nexus, answers });

      expect((await restore(['ModA'])).refused).toEqual([{ item: 'ModA', reason: `was skipped: installation file 'ModA.7z' is missing.${why}` }]);
    });

    it('lets the server\'s connection go when the Instance adapter refuses the file before it reads it', async () => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; } });
      const { nexus } = await nexusServing({ ...servingFile78(PACK), [FILE_78.server]: new Response(body) });
      const { restore } = await over({ manifests, nexus, answers: { refusals: refusing('putDownloadedFile', 'ENOSPC') } });

      await restore(['ModA']);

      expect(cancelled).toBe(true);
    });

    it('is copied to the pinned name from the downloaded file with its size and hash under another name, fetching nothing', async () => {
      const { nexus, sent } = await nexusServing(servingFile78(PACK));
      const renamed = { ...DOWNLOADED, path: '/downloads/Renamed-copy.7z', hash: PACK };
      const { restore, fake } = await over({
        files: { ModA: { 'a.nif': EDITED } }, manifests: { ModA: fromTheZip({ 'a.nif': HA }) },
        nexus, answers: { downloadedFiles: new Map([['Renamed-copy.7z', read(renamed)]]) },
      });

      const outcome = await restore(['ModA']);

      expect(fake.calls).toContainEqual({ verb: 'copyDownloadedFile', from: '/downloads/Renamed-copy.7z', name: 'ModA.7z' });
      expect(writes(fake.calls)[0]).toEqual({ verb: 'writeFilesIn', folder: folderOf('ModA'), files: [{ path: 'a.nif', from: { kind: 'entry', downloadedFile: '/downloads/ModA.7z', entry: 'a.nif' } }] });
      expect([outcome.refused, sent]).toEqual([[], []]);
    });

    it('refuses a file of the pinned name with other bytes, naming the file that holds the pinned bytes, and overwrites nothing', async () => {
      const { nexus } = await nexusServing(servingFile78(PACK));
      const { restore, fake } = await over({
        manifests: { ModA: fromTheZip({ 'a.nif': HA }) },
        nexus, answers: { downloadedFiles: new Map([['ModA.7z', read({ ...DOWNLOADED, hash: EDITED })], ['Renamed-copy.7z', read({ ...DOWNLOADED, path: '/downloads/Renamed-copy.7z', hash: PACK })]]) },
      });

      const outcome = await restore(['ModA']);

      expect(outcome.refused).toEqual([{ item: 'ModA', reason: "was skipped: installation file 'ModA.7z' has other bytes. /downloads/Renamed-copy.7z holds the pinned bytes of 'ModA.7z'." }]);
      expect(fake.calls.filter(({ verb }) => verb === 'copyDownloadedFile' || verb === 'putDownloadedFile')).toEqual([]);
    });

    it('refuses a file of the pinned name that cannot be read, naming the file that holds the pinned bytes', async () => {
      const { nexus } = await nexusServing(servingFile78(PACK));
      const { restore } = await over({
        manifests: { ModA: fromTheZip({ 'a.nif': HA }) },
        nexus, answers: { downloadedFiles: new Map([['ModA.7z', { kind: 'unreadable', reason: 'Is not archive' }], ['Renamed-copy.7z', read({ ...DOWNLOADED, path: '/downloads/Renamed-copy.7z', hash: PACK })]]) },
      });

      expect((await restore(['ModA'])).refused).toEqual([{ item: 'ModA', reason: "was skipped: installation file 'ModA.7z' could not be read: Is not archive. /downloads/Renamed-copy.7z holds the pinned bytes of 'ModA.7z'." }]);
    });

    it('refuses the mod, naming why, when the copy to the pinned name fails', async () => {
      const { nexus } = await nexusServing(servingFile78(PACK));
      const renamed = { ...DOWNLOADED, path: '/downloads/Renamed-copy.7z', hash: PACK };
      const { restore } = await over({
        manifests: { ModA: fromTheZip({ 'a.nif': HA }) },
        nexus, answers: { downloadedFiles: new Map([['Renamed-copy.7z', read(renamed)]]), refusals: refusing('copyDownloadedFile', 'ENOSPC') },
      });

      expect((await restore(['ModA'])).refused).toEqual([{ item: 'ModA', reason: "was skipped: installation file 'ModA.7z' is missing. It could not be copied from /downloads/Renamed-copy.7z: ENOSPC." }]);
    });

    it('asks Nexus nothing for an installation file the downloads folder holds', async () => {
      const { nexus, sent } = await nexusServing(servingFile78(PACK));
      const { restore } = await over({ manifests, nexus, answers: { downloadedFiles: new Map([['ModA.7z', read({ ...DOWNLOADED, hash: PACK })]]) } });

      await restore(['ModA']);

      expect(sent).toEqual([]);
    });

    it('downloads nothing for the next mod once a cancel aborts its signal', async () => {
      const cancel = new AbortController();
      const { nexus, sent } = await nexusServing({ ...servingFile78(PACK), [FILE_78.record]: new Response('', { status: 404 }) });
      const { restore } = await over({ manifests: { ...manifests, ModB: manifests.ModA }, nexus });

      const outcome = await restore(['ModA', 'ModB'], { onProgress: (status) => { if (status.phase === 'Downloading') cancel.abort(); }, signal: cancel.signal });

      expect([sent.map(({ url }) => url), outcome.refused.at(-1)]).toEqual([[FILE_78.record], { item: 'ModB', reason: NOT_FINISHED }]);
    });
  });

  describe('a source mod with a remote', () => {
    const source = (): string => join(root, 'source', 'ModA');
    const pinned = (): { folder: string; pin: string; branch: string } => ({ folder: source(), pin: 'abc', branch: 'main' });
    const BUILT = { mod: 'ModA', compiled: [], refused: [], archivesRefused: [], made: [{ path: 'a.esp', vouchedFor: true }, { path: 'b.nif', vouchedFor: true }] };

    async function sourceMod(answers: InstanceAnswers = {}, exclude: string[] = [], sourceFolderHolds?: { manifest: Manifest; files: Record<string, string>; heldByGit: string[]; modFiles?: Record<string, string> }, ignore: string[] = []) {
      await mkdir(source(), { recursive: true });
      await writeBuildFile(source(), buildFileOf());
      if (sourceFolderHolds !== undefined) await writeManifestIn(source(), sourceFolderHolds.manifest);
      const setup = await over({
        foldersOutsideMods: sourceFolderHolds === undefined ? {} : { [source()]: sourceFolderHolds.files },
        files: { ModA: { 'a.esp': EDITED, 'b.nif': HB, 'mine.txt': 'M' } }, sourceFolders: { ModA: source() },
        manifests: { ModA: { packages: [REPOSITORY], exclude, ignore, flags: new Map(), files: holding({ 'a.esp': HA, 'b.nif': HB, ...sourceFolderHolds?.modFiles }) } },
        answers: { downloadedFiles: new Map([['ModA.7z', read(DOWNLOADED)]]), pins: new Map([['ModA', pinned()]]), heldByGit: new Map([[source(), sourceFolderHolds?.heldByGit ?? []]]), ...answers },
      });
      setup.client.setCommandResult('cloneSubmodules', { applied: [{ folder: source(), leftDetached: "its branch 'main' is at def" }], refused: [] });
      setup.client.setCommandHandler('build', () => {
        setup.hashes.set(join(folderOf('ModA'), 'a.esp'), { size: 1, hash: HC });
        return Promise.resolve({ landed: [BUILT], refused: [] });
      });
      return setup;
    }

    it('is built although its mod folder is one git holds whole, since the build makes that folder', async () => {
      const { restore, client } = await sourceMod({ heldWholeByGit: new Set([folderOf('ModA')]) });

      const outcome = await restore(['ModA']);

      expect([outcome.refused, outcome.landed.map(({ mod }) => mod), client.calls.map(({ method }) => method)]).toEqual([[], ['ModA'], ['cloneSubmodules', 'build']]);
    });

    it('is built by mEdit at the commit the instance repository pins, reading only its source folder, and its files the build does not make sent to the trash', async () => {
      const { restore, client, fake } = await sourceMod();

      const outcome = await restore(['ModA']);

      expect(client.calls.map(({ method, args }) => [method, args[0]])).toEqual([
        ['cloneSubmodules', [pinned()]],
        ['build', [{ name: 'ModA', sourceFolder: source(), folder: folderOf('ModA'), exclude: [], ignore: [], step: { compile: ['A.esp'] } }]],
      ]);
      expect(writes(fake.calls)).toMatchObject([{ verb: 'trashFileIn' }]);
      expect(outcome).toEqual({ landed: [{ mod: 'ModA', written: ['a.esp'], namedByNoLine: ['mine.txt'], leftDetached: "its branch 'main' is at def" }], refused: [] });
    });

    describe('whose source folder has a manifest', () => {
      const sourceHolds = {
        manifest: fromTheZip({ 'a.nif': HA }),
        files: { 'a.nif': EDITED, 'junk.txt': 'J', 'plugin.json': EDITED, '.git': 'G', '.git/HEAD': 'H' },
        heldByGit: ['plugin.json'],
      };

      it('has its source folder restored from it before the build, leaving alone a file git holds, edited or not, and git\'s own', async () => {
        const { restore, client, fake } = await sourceMod({}, [], sourceHolds);

        const outcome = await restore(['ModA']);

        const entry = { kind: 'entry', downloadedFile: '/downloads/ModA.7z', entry: 'a.nif' };
        expect(writes(fake.calls).filter((call) => 'folder' in call && call.folder === source())).toEqual([
          { verb: 'writeFilesIn', folder: source(), files: [{ path: 'a.nif', from: entry }] },
          { verb: 'trashFileIn', folder: source(), relativePath: 'junk.txt' },
        ]);
        expect([client.calls.map(({ method }) => method), outcome.refused]).toEqual([['cloneSubmodules', 'build'], []]);
      });

      it('writes a game file its manifest names at the layout\'s path from the game folder, as the mod folder holds it', async () => {
        const named = { manifest: { packages: [{ kind: 'gameFolder' } as const], exclude: [], ignore: [], flags: new Map(), files: holding({ 'assets/x.nif': HA }) }, files: {}, heldByGit: [], modFiles: { 'x.nif': HA } };
        const { restore, fake } = await sourceMod({ gameFilesTaken: takenFromTheGame(['Data/x.nif', HA, 'x.nif']) }, [], named);

        await restore(['ModA']);

        expect(writes(fake.calls).filter((call) => 'folder' in call && call.folder === source())).toEqual([
          { verb: 'writeFilesIn', folder: source(), files: [{ path: 'assets/x.nif', from: { kind: 'gameFile', root: '/game', path: 'Data/x.nif' } }] },
        ]);
      });

      it('reports the files restored in its source folder with the mod\'s, under the folder\'s name', async () => {
        const { restore } = await sourceMod({}, [], sourceHolds);

        const [landed] = (await restore(['ModA'])).landed;

        expect([landed?.written, landed?.namedByNoLine]).toEqual([['ModA/a.nif', 'a.esp'], ['ModA/junk.txt', 'mine.txt']]);
      });

      it('is skipped, naming why, and not built, when git cannot list its source folder', async () => {
        const { restore, client, deps } = await sourceMod({}, [], sourceHolds);
        Object.assign(deps.adapter, { unheldFolderValue: () => Promise.reject(new Error('fatal: not a git repository')) });

        const outcome = await restore(['ModA']);

        expect([outcome.refused, client.calls.map(({ method }) => method)]).toEqual([
          [{ item: 'ModA', reason: 'was skipped: a file could not be read: fatal: not a git repository.' }], ['cloneSubmodules'],
        ]);
      });

      it('is skipped, and not built, when a file of its source folder is held by no package', async () => {
        const { restore, client } = await sourceMod({}, [], { ...sourceHolds, manifest: fromTheZip({ 'a.nif': HC.replace('C', 'Z') }) });

        const outcome = await restore(['ModA']);

        expect([outcome.refused.map(({ item }) => item), client.calls.map(({ method }) => method)]).toEqual([['ModA'], ['cloneSubmodules']]);
      });
    });

    it('is built from a repository the source folder holds that is no submodule, cloning nothing (instance-repository.md, Restore from manifest, story 1)', async () => {
      const { restore, client } = await sourceMod({ pins: new Map() });

      const outcome = await restore(['ModA']);

      expect([client.calls.map(({ method }) => method), outcome.landed.map(({ mod }) => mod)]).toEqual([['build'], ['ModA']]);
    });

    it('is built over the paths its manifest ignores, which its build sends to the trash no more than it records (The manifest, story 11)', async () => {
      const { restore, client, fake } = await sourceMod({}, [], undefined, ['mine.txt']);

      const outcome = await restore(['ModA']);

      expect(writes(fake.calls)).toEqual([]);
      expect(client.calls.find(({ method }) => method === 'build')?.args[0]).toMatchObject([{ name: 'ModA', ignore: ['mine.txt'] }]);
      expect(outcome).toMatchObject({ landed: [{ mod: 'ModA', namedByNoLine: [] }] });
    });

    it('is built with the exclusions its manifest records, whatever its folder holds', async () => {
      const { restore, client } = await sourceMod({}, ['a.esp']);

      await restore(['ModA']);

      expect(client.calls.find(({ method }) => method === 'build')?.args[0]).toMatchObject([{ name: 'ModA', exclude: ['a.esp'] }]);
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

      expect((await restore(['ModA'])).refused).toEqual([{ item: 'ModA', reason: "was skipped: its submodule could not be cloned or read: its remote holds no commit abc." }]);
    });

    it('is not finished when its build left a plugin as it was', async () => {
      const { restore, client } = await sourceMod();
      client.setCommandHandler('build', () => Promise.resolve({ landed: [{ ...BUILT, refused: [{ item: { name: 'A.esp', origin: 'ModA' }, reason: 'A.esp was not compiled: it holds an error.' }] }], refused: [] }));

      expect((await restore(['ModA'])).refused).toEqual([{ item: 'ModA', reason: 'was not finished: A.esp was not compiled: it holds an error.' }]);
    });

    it('is skipped with its build\'s reason when the build refused it', async () => {
      const { restore, client } = await sourceMod();
      client.setCommandHandler('build', () => Promise.resolve({ landed: [], refused: [{ item: 'ModA', reason: 'no load order is held.' }] }));

      expect((await restore(['ModA'])).refused).toEqual([{ item: 'ModA', reason: 'was not built: no load order is held.' }]);
    });
  });

  describe('before a source mod', () => {
    const MODS = ['ModA', 'ModB', 'ModC'].map((name) => ({ kind: 'mod', name, enabled: true }) as const);
    const C_ESP = { origin: { kind: 'mod', name: 'ModC' }, name: 'C.esp' } as const;
    beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); });
    afterEach(() => { vi.useRealTimers(); });

    async function aSourceModAfterTwoMods() {
      const source = join(root, 'source', 'ModA');
      await mkdir(source, { recursive: true });
      await writeBuildFile(source);
      const setup = await over({
        manifests: { ModA: { ...EMPTY, packages: [REPOSITORY] }, ModB: EMPTY, ModC: EMPTY },
        sourceFolders: { ModA: source }, reading: { mods: [...MODS], ...pluginFilesHeld(C_ESP) },
      });
      setup.client.setCommandResult('build', { landed: [{ mod: 'ModA', compiled: [], refused: [], archivesRefused: [], made: [] }], refused: [] });
      return setup;
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
      ['is not answered of by mEdit', { failed: 'timed-out', cause: 'mEdit cannot say.' } as const, 0, 'was restored, but plugin C.esp (mEdit cannot say.)'],
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

    it('ends the wait for the record index when a cancel aborts its signal, naming no plugin', async () => {
      const { restore, client } = await aSourceModAfterTwoMods();
      client.setQueryAnswer('getPluginIndexing', { state: 'NotYet' });
      const cancel = new AbortController();

      const outcome = restore(['ModA', 'ModB', 'ModC'], { signal: cancel.signal });
      await waiting(client);
      cancel.abort();

      expect((await outcome).refused).toEqual([]);
    });

    it('waits while mEdit says a read is not yet answerable', async () => {
      const { restore, client } = await aSourceModAfterTwoMods();
      client.setQueryAnswer('getPluginIndexing', { failed: 'no-load-order' });
      let ended = false;

      const outcome = restore(['ModA', 'ModB', 'ModC']).finally(() => { ended = true; });
      await waiting(client);
      await vi.advanceTimersByTimeAsync(1_000);
      const endedBeforeIndexed = ended;
      client.setQueryAnswer('getPluginIndexing', { state: 'AsOnDisk' });
      client.emit(loadOrderStatusEventFixture());

      expect([endedBeforeIndexed, (await outcome).refused]).toEqual([false, []]);
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

  describe('a plugin its manifest flags (Restore from manifest, story 1)', () => {
    const PLUGIN_7Z: InstallationFile = { ...DOWNLOADED, entries: [{ path: 'Mod.esp', hash: HA }] };
    const FLAGS = { Small: true };
    const setup = (onDisk: string): Setup => ({
      files: { ModA: { 'Mod.esp': onDisk } }, manifests: { ModA: fromTheZip({ 'Mod.esp': HA }, { flags: new Map([['Mod.esp', FLAGS]]) }) },
      answers: { downloadedFiles: new Map([['ModA.7z', read(PLUGIN_7Z)]]) },
    });
    const pluginAt = (): string => join(folderOf('ModA'), 'Mod.esp');
    const couldHaveHeld = (client: InMemoryMEditClient, hashes: string[]) => client.setQueryAnswer('getFlaggedPluginHashes', [{ path: pluginAt(), hashes }]);
    const flagsSetBy = (client: InMemoryMEditClient, hash: string) => client.setCommandResult('setPluginFileFlags', { applied: [{ path: pluginAt(), hash }], refused: [] });
    const setCalls = (client: InMemoryMEditClient) => client.calls.filter(({ method }) => method === 'setPluginFileFlags');

    it('takes the package\'s copy and sets the flags in it when the file could not have held the copy before its flags', async () => {
      const { restore, client, fake } = await over(setup(EDITED));
      couldHaveHeld(client, []);
      flagsSetBy(client, HC);

      const outcome = await restore(['ModA']);

      expect([outcome.landed.map(({ written }) => written), writes(fake.calls).map(({ verb }) => verb), setCalls(client)]).toEqual([
        [['Mod.esp']], ['writeFilesIn', 'writeInstalledFrom'],
        [{ method: 'setPluginFileFlags', args: ['Fallout4', [{ path: pluginAt(), flags: FLAGS }]] }],
      ]);
    });

    it('asks mEdit what the file could have held before its flags, and leaves it alone when that is the copy', async () => {
      const { restore, client, fake } = await over(setup(HC));
      couldHaveHeld(client, [HA, HC]);

      const outcome = await restore(['ModA']);

      expect([outcome.landed.map(({ written }) => written), writes(fake.calls).map(({ verb }) => verb), client.calls]).toEqual([
        [[]], ['writeInstalledFrom'], [{ method: 'getFlaggedPluginHashes', args: ['Fallout4', [{ path: pluginAt(), flags: FLAGS }]] }],
      ]);
    });

    it('refuses the mod as skipped, saying why, when mEdit cannot say what the file could have held', async () => {
      const { restore, client, fake } = await over(setup(HC));
      client.setQueryFailure('getFlaggedPluginHashes', { failed: 'refused', refusal: 'mEdit is gone' });

      const outcome = await restore(['ModA']);

      expect([outcome.refused, writes(fake.calls).map(({ verb }) => verb)]).toEqual([[{ item: 'ModA', reason: 'was skipped: mEdit is gone.' }], []]);
    });

    it('refuses the mod as not finished, naming every plugin mEdit refused', async () => {
      const second = { ...MOD_7Z };
      const { restore, client } = await over({
        files: { ModA: { 'Mod.esp': HA, 'Two.esp': HB } },
        manifests: { ModA: fromTheZip({ 'Mod.esp': HA, 'Two.esp': HB }, { flags: new Map([['Mod.esp', FLAGS], ['Two.esp', FLAGS]]), packages: [second] }) },
        answers: { downloadedFiles: new Map([['ModA.7z', read({ ...DOWNLOADED, entries: [{ path: 'Mod.esp', hash: HA }, { path: 'Two.esp', hash: HB }] })]]) },
      });
      client.setQueryAnswer('getFlaggedPluginHashes', [{ path: pluginAt(), hashes: [] }, { path: join(folderOf('ModA'), 'Two.esp'), hashes: [] }]);
      client.setCommandResult('setPluginFileFlags', { applied: [], refused: [
        { item: join(folderOf('ModA'), 'Mod.esp'), refusal: 'NotAPlugin', message: 'it is no plugin' },
        { item: join(folderOf('ModA'), 'Two.esp'), refusal: 'UnknownFlag', message: "'Small' is no load flag" },
      ] });

      const outcome = await restore(['ModA']);

      expect(outcome.refused).toEqual([
        { item: 'ModA', reason: `was not finished: ${join(folderOf('ModA'), 'Mod.esp')}: it is no plugin; ${join(folderOf('ModA'), 'Two.esp')}: 'Small' is no load flag. Restoring it again finishes it.` },
      ]);
    });

    it('refuses the mod as not finished when the call to mEdit is refused', async () => {
      const { restore, client } = await over(setup(HA));
      couldHaveHeld(client, []);
      client.setCommandResult('setPluginFileFlags', { refused: true, message: 'mEdit is gone' });

      expect((await restore(['ModA'])).refused).toEqual([{ item: 'ModA', reason: 'was not finished: mEdit is gone. Restoring it again finishes it.' }]);
    });
  });

  it('writes a plugin the manifest names under another name than its package\'s from the entry that holds its bytes (The manifest, story 9)', async () => {
    const { restore, fake } = await over({
      files: { ModA: {} }, manifests: { ModA: fromTheZip({ 'Renamed.esp': HA }) },
      answers: { downloadedFiles: new Map([['ModA.7z', read({ ...DOWNLOADED, entries: [{ path: 'Original.esp', hash: HA }] })]]) },
    });

    await restore(['ModA']);

    expect(writes(fake.calls)[0]).toEqual({
      verb: 'writeFilesIn', folder: folderOf('ModA'), files: [{ path: 'Renamed.esp', from: { kind: 'entry', downloadedFile: '/downloads/ModA.7z', entry: 'Original.esp' } }],
    });
  });
});
