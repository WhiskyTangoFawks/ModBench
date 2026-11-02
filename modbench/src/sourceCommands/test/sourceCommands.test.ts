import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { fakeInstanceAdapter, modFoldersIn, readingFixture, repositoriesOf, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { sourceCommands } from '../sourceCommands';
import { isPluginSourcePath } from '../../instanceAdapter/instanceAdapter';
import { recordingTasks } from '../../test/recordingTasks';
import { manifestIn, writeManifestIn, type BuildStep, type Manifest, type TaskStep } from '../../manifestAdapter/manifestAdapter';
import { buildFileOf, writeBuildFile } from '../../test/buildFiles';
import { BUILD_FILE } from '../../wire/sourceMod';
import type { ModToInitSourceMod } from '../../client';
import type { BuildMod } from '../../client/MEditClient';

let root: string;
let SOURCES: { ModA: string; ModB: string };

const folderOf = (mod: string): string => join(root, 'mods', mod);

const COMPILE: BuildStep = { kind: 'compile', paths: ['A.esp'] };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'source-commands-'));
  SOURCES = { ModA: join(root, 'ModA'), ModB: join(root, 'Old ModB') };
  for (const [mod, folder] of Object.entries(SOURCES)) {
    await mkdir(folder, { recursive: true });
    await mkdir(folderOf(mod), { recursive: true });
    await writeBuildFile(folder, buildFileOf({ steps: [COMPILE] }));
  }
});
afterEach(() => rm(root, { recursive: true, force: true }));

const fakeAdapter = (answers: InstanceAnswers = {}, gameRelease = 'Fallout4') =>
  fakeInstanceAdapter(readingFixture({
    gameRelease, modFolders: modFoldersIn(join(root, 'mods'), 'ModA'), sourceRepositories: repositoriesOf(SOURCES),
  }), answers).adapter;

const recorded = async (mod: string): Promise<Manifest | undefined> => {
  const read = await manifestIn(folderOf(mod));
  return read === undefined || 'refused' in read ? undefined : read.manifest;
};

const EXCLUSION_MARK = fakeInstanceAdapter().adapter.exclusionMark;
const savedAll = () => Promise.resolve([]);
const BA2 = { ba2: { version: 1, compressed: true } };

const builtOf = (mod: string) => ({ mod, compiled: [], refused: [], archivesRefused: [], made: [] });
const landedOf = (mod: string) => ({ mod, compiled: [], refused: [], archivesRefused: [] });
const buildingEach = (client: InMemoryMEditClient): void => {
  client.setCommandHandler('build', (mods: readonly BuildMod[]) => Promise.resolve({ landed: mods.map((mod) => builtOf(mod.name)), refused: [] }));
};

describe('sourceCommands build', () => {
  it('hands mEdit each built-in step of each mod\'s build file in order, one call each, with the source folder that builds it, its folder, what its folder excludes, the exclusion mark and the release\'s archive variants', async () => {
    await writeBuildFile(SOURCES.ModA, buildFileOf({ steps: [
      { kind: 'decompile', paths: ['A.esp'] }, { kind: 'copy', paths: ['textures'] }, COMPILE, { kind: 'pack', archives: [{ path: 'ModA - Main.ba2', files: ['a.nif'] }] }, { kind: 'unpack', archives: [{ path: 'Base.ba2', files: ['b.nif'] }] },
    ] }));
    const client = new InMemoryMEditClient();
    buildingEach(client);

    await sourceCommands({ client, adapter: fakeAdapter({ folderFiles: new Map([[folderOf('ModA'), [`b.dds${EXCLUSION_MARK}`, 'c.dds']]]) }), saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() })
      .build(['ModA', 'ModB']);

    const facts = { exclusionMark: EXCLUSION_MARK, archives: { general: BA2, textures: BA2 } };
    const modA = { name: 'ModA', sourceFolder: SOURCES.ModA, folder: folderOf('ModA'), exclude: ['b.dds'], ignore: [] };
    expect(client.calls).toEqual([
      { method: 'build', args: [[{ ...modA, step: { decompile: ['A.esp'] } }], facts] },
      { method: 'build', args: [[{ ...modA, step: { copy: ['textures'] } }], facts] },
      { method: 'build', args: [[{ ...modA, step: { compile: ['A.esp'] } }], facts] },
      { method: 'build', args: [[{ ...modA, step: { pack: [{ path: 'ModA - Main.ba2', files: ['a.nif'] }] } }], facts] },
      { method: 'build', args: [[{ ...modA, step: { unpack: [{ path: 'Base.ba2', files: ['b.nif'] }] } }], facts] },
      { method: 'build', args: [[{ name: 'ModB', sourceFolder: SOURCES.ModB, folder: folderOf('ModB'), exclude: [], ignore: [], step: { compile: ['A.esp'] } }], facts] },
    ]);
  });

  it('keeps each exclusion the manifest records whose file the folder does not hold (mods.md, A source mod, story 2)', async () => {
    const recording: Manifest = { packages: [{ kind: 'repository', name: 'ModA' }], exclude: ['docs'], ignore: [], flags: new Map(), files: new Map([['docs/readme.txt', 'AAAAAAAAAAA=']]) };
    await writeManifestIn(folderOf('ModA'), recording);
    const client = new InMemoryMEditClient();
    buildingEach(client);

    await sourceCommands({ client, adapter: fakeAdapter(), saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() }).build(['ModA']);

    expect(client.calls).toMatchObject([{ args: [[{ name: 'ModA', exclude: ['docs'] }], expect.anything()] }]);
  });

  it('refuses a mod whose manifest cannot be read, naming why, as its exclusions are there', async () => {
    await writeFile(join(folderOf('ModA'), 'ModA.manifest.json'), '{');
    const client = new InMemoryMEditClient();

    const outcome = await sourceCommands({ client, adapter: fakeAdapter(), saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() }).build(['ModA']);

    expect([client.calls, outcome]).toEqual([[], { landed: [], refused: [{ item: 'ModA', reason: "was not built: its manifest is not valid JSON at line 1: Expected property name or '}' in JSON at position 1." }] }]);
  });

  it('saves each mod\'s source folder, and refuses a mod whose file VS Code leaves unsaved, naming the file, while the rest build', async () => {
    const client = new InMemoryMEditClient();
    buildingEach(client);
    const saved: string[] = [];
    const predicates: ((path: string) => boolean)[] = [];
    const saveUnsaved = (folder: string, isPluginSource: (path: string) => boolean) => {
      saved.push(folder);
      predicates.push(isPluginSource);
      return Promise.resolve(folder.endsWith('Old ModB') ? [`${folder}/plugin-source/B.esp/Cell.json`] : []);
    };

    const outcome = await sourceCommands({ client, adapter: fakeAdapter(), saveUnsaved, tasks: recordingTasks(), trash: vi.fn() }).build(['ModA', 'ModB']);

    expect(saved).toEqual([SOURCES.ModA, SOURCES.ModB]);
    expect(predicates).toEqual([isPluginSourcePath, isPluginSourcePath]);
    expect(client.calls.map((call) => call.args[0])).toMatchObject([[{ name: 'ModA' }]]);
    expect(outcome).toMatchObject({ refused: [{ item: 'ModB', reason: `VS Code did not save its plugin source: ${SOURCES.ModB}/plugin-source/B.esp/Cell.json` }] });
  });

  it('hands mEdit no archive variant for a release the table names none for', async () => {
    const client = new InMemoryMEditClient();
    buildingEach(client);

    await sourceCommands({ client, adapter: fakeAdapter({}, 'SkyrimSE'), saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() }).build(['ModA']);

    expect(client.calls.map((call) => call.args[1])).toEqual([{ exclusionMark: EXCLUSION_MARK, archives: null }]);
  });

  it.each<[string, InstanceAnswers, readonly string[], string, string, string]>([
    ['no repository builds', {}, ['ModA', 'ModC'], 'ModC', 'no repository in the source folder builds it', 'ModA'],
  ])('refuses a mod %s, naming why, and builds the rest', async (_case, answers, mods, item, reason, sent) => {
    const client = new InMemoryMEditClient();
    buildingEach(client);

    const outcome = await sourceCommands({ client, adapter: fakeAdapter(answers), saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() }).build(mods);

    expect(client.calls).toMatchObject([{ args: [[{ name: sent }], expect.anything()] }]);
    expect(outcome).toEqual({ landed: [landedOf(sent)], refused: [{ item, reason }] });
  });

  it.each<[string, () => Promise<void>, string, Record<string, true>]>([
    ['holds no build file', () => rm(join(SOURCES.ModA, BUILD_FILE)), 'was not built: \'<ModA>\' holds no build file.', {}],
    ['holds a build file of the format before version 1', () => writeFile(join(SOURCES.ModA, BUILD_FILE), '{"files": []}'), 'was not built: its build file is in a format before version 1, and Modbench reads only version 1.', {}],
    ['runs a tool this machine has no task for', () => writeBuildFile(SOURCES.ModA, buildFileOf({
      steps: [COMPILE, { kind: 'task', task: 'Zip', args: [], page: 'https://example.com/zip' }],
    })), 'was not built: this machine has no task for its tool \'Zip\' (https://example.com/zip).', { lacksATask: true }],
  ])('refuses a mod whose repository %s, naming why, before anything is written', async (_case, arrange, reason, flags) => {
    await arrange();
    const client = new InMemoryMEditClient();
    const fake = fakeInstanceAdapter(readingFixture({ sourceRepositories: repositoriesOf(SOURCES) }));

    const outcome = await sourceCommands({ client, adapter: fake.adapter, saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() }).build(['ModA']);

    expect([client.calls, fake.calls, outcome]).toEqual([[], [], { landed: [], refused: [{ item: 'ModA', reason: reason.replace('<ModA>', SOURCES.ModA), ...flags }] }]);
  });
});

describe('sourceCommands build, in mod order', () => {
  const ORDER = [{ kind: 'mod', name: 'ModA', enabled: true }, { kind: 'separator', name: 'Group', enabled: true }, { kind: 'mod', name: 'ModB', enabled: true }] as const;
  const winningFirst = () => fakeInstanceAdapter(readingFixture({ mods: [...ORDER], modFolders: modFoldersIn(join(root, 'mods'), 'ModA'), sourceRepositories: repositoriesOf(SOURCES) })).adapter;

  it('builds the mods from the losing end of mod order, the winning mod last, whatever order they were asked in', async () => {
    const client = new InMemoryMEditClient();
    buildingEach(client);

    const outcome = await sourceCommands({ client, adapter: winningFirst(), saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() }).build(['ModA', 'ModB']);

    expect(client.calls.map((call) => call.args[0])).toMatchObject([[{ name: 'ModB' }], [{ name: 'ModA' }]]);
    expect(outcome).toMatchObject({ landed: [{ mod: 'ModB' }, { mod: 'ModA' }] });
  });

  it('builds every source mod the adapter reads now, in mod order, when asked for every source', async () => {
    const client = new InMemoryMEditClient();
    buildingEach(client);

    const outcome = await sourceCommands({ client, adapter: winningFirst(), saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() }).build([], true);

    expect(outcome).toMatchObject({ landed: [{ mod: 'ModB' }, { mod: 'ModA' }] });
  });

  it('reports the mods that built when mEdit refuses a later mod, and refuses that mod and the rest, naming why', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandHandler('build', (mods: readonly BuildMod[]) =>
      Promise.resolve(mods[0]?.name === 'ModB' ? { landed: [builtOf('ModB')], refused: [] } : { refused: true as const, message: 'mEdit stopped' }));

    const outcome = await sourceCommands({ client, adapter: winningFirst(), saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() }).build(['ModA', 'ModB']);

    expect(outcome).toEqual({ landed: [landedOf('ModB')], refused: [{ item: 'ModA', reason: 'was not built: mEdit stopped' }] });
  });

  it('runs a mod\'s task step in its folder after the step before it, and writes its manifest, before the next mod builds', async () => {
    const step: TaskStep = { kind: 'task', task: 'Patch', args: ['a'], page: 'https://example.com/patch' };
    await writeBuildFile(SOURCES.ModB, buildFileOf({ steps: [COMPILE, step] }));
    const log: string[] = [];
    const client = new InMemoryMEditClient();
    client.setCommandHandler('build', (mods: readonly BuildMod[]) => {
      log.push(`build ${mods[0]?.name ?? ''}`);
      return Promise.resolve({ landed: mods.map((mod) => builtOf(mod.name)), refused: [] });
    });
    const tasks = recordingTasks(['Patch']);
    const logging = {
      ...tasks,
      whyStepFailed: async (...ran: Parameters<typeof tasks.whyStepFailed>) => {
        log.push(`step in ${ran[1].folder === folderOf('ModB') ? 'ModB' : ran[1].folder} ${await recorded('ModB') === undefined ? 'before' : 'after'} its manifest`);
        return tasks.whyStepFailed(...ran);
      },
    };

    await sourceCommands({ client, adapter: winningFirst(), saveUnsaved: savedAll, tasks: logging, trash: vi.fn() }).build(['ModA', 'ModB']);

    expect(log).toEqual(['build ModB', 'step in ModB before its manifest', 'build ModA']);
    expect(tasks.runs).toEqual([{ step, folder: folderOf('ModB') }]);
    expect(await recorded('ModB')).toMatchObject({ packages: [{ kind: 'repository', name: 'Old ModB' }] });
  });

  it('stops a mod\'s build at a failed step, running no step after it (source.md, Build, story 18)', async () => {
    await writeBuildFile(SOURCES.ModA, buildFileOf({ steps: [{ kind: 'task', task: 'First', args: [] }, COMPILE, { kind: 'task', task: 'Second', args: [] }] }));
    const client = new InMemoryMEditClient();
    buildingEach(client);
    const tasks = recordingTasks(['First', 'Second'], { [folderOf('ModA')]: "step 'First' exited with code 1" });

    const outcome = await sourceCommands({ client, adapter: fakeAdapter(), saveUnsaved: savedAll, tasks, trash: vi.fn() }).build(['ModA']);

    expect([tasks.runs.map(({ step }) => step), client.calls]).toEqual([[{ kind: 'task', task: 'First', args: [] }], []]);
    expect(outcome).toEqual({ landed: [{ ...landedOf('ModA'), failure: "The build stopped as its step 'First' exited with code 1." }], refused: [] });
  });

  it.each<[string, readonly BuildStep[], unknown, number]>([
    ['refuses the mod when its first step is refused', [{ kind: 'copy', paths: ['textures'] }, COMPILE],
      { landed: [], refused: [{ item: 'ModA', reason: "was not built: '/s' holds no 'textures' to copy." }] }, 1],
    ['lands the mod, naming why, when a later step is refused, and runs no step after it', [COMPILE, { kind: 'copy', paths: ['textures'] }, COMPILE],
      { landed: [{ ...landedOf('ModA'), failure: "The build stopped at its step 2: '/s' holds no 'textures' to copy." }], refused: [] }, 2],
  ])('%s (source.md, Build, story 18)', async (_case, steps, expected, calls) => {
    await writeBuildFile(SOURCES.ModA, buildFileOf({ steps }));
    const client = new InMemoryMEditClient();
    client.setCommandHandler('build', (mods: readonly BuildMod[]) => Promise.resolve(mods[0]?.step?.copy === undefined
      ? { landed: [builtOf('ModA')], refused: [] }
      : { landed: [], refused: [{ item: 'ModA', reason: "'/s' holds no 'textures' to copy." }] }));

    const outcome = await sourceCommands({ client, adapter: fakeAdapter(), saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() }).build(['ModA']);

    expect([outcome, client.calls.length]).toEqual([expected, calls]);
  });

  it('stops after a step that refused a plugin when a step comes after it, and lands the mod with the plugin refused', async () => {
    await writeBuildFile(SOURCES.ModA, buildFileOf({ steps: [COMPILE, { kind: 'copy', paths: ['textures'] }] }));
    const client = new InMemoryMEditClient();
    const refused = [{ item: { name: 'A.esp', origin: 'ModA' }, reason: 'A.esp was not compiled.' }];
    client.setCommandHandler('build', () => Promise.resolve({ landed: [{ ...builtOf('ModA'), refused }], refused: [] }));

    const outcome = await sourceCommands({ client, adapter: fakeAdapter(), saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() }).build(['ModA']);

    expect([outcome, client.calls.length]).toEqual([{ landed: [{ ...landedOf('ModA'), refused, failure: 'The build stopped after its step 1, which refused a file.' }], refused: [] }, 1]);
  });

  describe('a decompile step (source.md, Build, story 17)', () => {
    const ASIDE = [
      { aside: '.medit_tmp_1_x/A.esp', path: 'plugin-source/A.esp' },
      { aside: '.medit_tmp_1_x/a.ESP', path: 'plugin-source/a.ESP' },
    ];
    const decompiling = async (answer: Awaited<ReturnType<InMemoryMEditClient['build']>>) => {
      await writeBuildFile(SOURCES.ModA, buildFileOf({ steps: [{ kind: 'decompile', paths: ['A.esp', 'B.esp'] }] }));
      const client = new InMemoryMEditClient();
      const fake = fakeInstanceAdapter(readingFixture({ modFolders: modFoldersIn(join(root, 'mods'), 'ModA'), sourceRepositories: repositoriesOf(SOURCES) }));
      const log: unknown[] = [];
      const adapter = { ...fake.adapter, trashFileIn: (...[folder, path, trash, asPath]: Parameters<typeof fake.adapter.trashFileIn>) => {
        log.push({ trashed: path, in: folder, as: asPath });
        return fake.adapter.trashFileIn(folder, path, trash, asPath);
      } };
      client.setCommandHandler('build', (mods: readonly BuildMod[]) => {
        log.push({ step: mods[0]?.step });
        return Promise.resolve(answer);
      });
      const outcome = await sourceCommands({ client, adapter, saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() }).build(['ModA']);
      return { outcome, log };
    };

    it('has mEdit decompile once, then sends each plugin source folder mEdit moved aside to the trash as the path it had', async () => {
      const { log } = await decompiling({ landed: [{ ...builtOf('ModA'), replaced: ASIDE }], refused: [] });

      expect(log).toEqual([
        { step: { decompile: ['A.esp', 'B.esp'] } }, ...ASIDE.map(({ aside, path }) => ({ trashed: aside, in: SOURCES.ModA, as: path })),
      ]);
    });

    it('sends what mEdit moved aside to the trash though the decompile then stopped', async () => {
      const { log, outcome } = await decompiling({ landed: [{ ...builtOf('ModA'), replaced: ASIDE, failure: 'The build stopped at its decompile.' }], refused: [] });

      expect([log.slice(1), outcome]).toEqual([ASIDE.map(({ aside, path }) => ({ trashed: aside, in: SOURCES.ModA, as: path })), { landed: [{ ...landedOf('ModA'), failure: 'The build stopped at its decompile.' }], refused: [] }]);
    });

    it('sends nothing to the trash and refuses the mod when mEdit refuses it (commands.md, An item that cannot proceed writes nothing)', async () => {
      const { outcome, log } = await decompiling({ landed: [], refused: [{ item: 'ModA', reason: 'A.esp does not round-trip.' }] });

      expect([outcome, log]).toEqual([{ landed: [], refused: [{ item: 'ModA', reason: 'was not built: A.esp does not round-trip.' }] }, [{ step: { decompile: ['A.esp', 'B.esp'] } }]]);
    });
  });

  it.each([['pack', {}], ['unpack', { unpacking: true }]] as const)('marks an archive a %s step refused by the step that refused it', async (kind, marked) => {
    await writeBuildFile(SOURCES.ModA, buildFileOf({ steps: [{ kind, archives: [{ path: 'Base.ba2', files: ['a.nif'] }] }] }));
    const client = new InMemoryMEditClient();
    client.setCommandHandler('build', () => Promise.resolve({ landed: [{ ...builtOf('ModA'), archivesRefused: [{ item: 'Base.ba2', reason: 'it cannot be read' }] }], refused: [] }));

    const outcome = await sourceCommands({ client, adapter: fakeAdapter(), saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() }).build(['ModA']);

    expect('landed' in outcome ? outcome.landed[0]?.archivesRefused : undefined).toEqual([{ item: 'Base.ba2', reason: 'it cannot be read', ...marked }]);
  });

  it('sends each loose file a pack step packed to the trash (source.md, Build, stories 2 and 20)', async () => {
    await writeBuildFile(SOURCES.ModA, buildFileOf({ steps: [{ kind: 'pack', archives: [{ path: 'ModA.ba2', files: ['textures/a.dds'] }] }] }));
    const client = new InMemoryMEditClient();
    client.setCommandHandler('build', () => Promise.resolve({ landed: [{ ...builtOf('ModA'), packed: ['Textures/a.dds'] }], refused: [] }));
    const fake = fakeInstanceAdapter(readingFixture({ modFolders: modFoldersIn(join(root, 'mods'), 'ModA'), sourceRepositories: repositoriesOf(SOURCES) }));

    await sourceCommands({ client, adapter: fake.adapter, saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() }).build(['ModA']);

    expect(fake.calls.filter((call) => call.verb === 'trashFileIn')).toEqual([{ verb: 'trashFileIn', folder: folderOf('ModA'), relativePath: 'Textures/a.dds' }]);
  });

  it('sends no loose file a pack step packed to the trash that its manifest ignores (The manifest, story 11)', async () => {
    await writeBuildFile(SOURCES.ModA, buildFileOf({ steps: [{ kind: 'pack', archives: [{ path: 'ModA.ba2', files: ['textures'] }] }] }));
    await writeManifestIn(folderOf('ModA'), { packages: [{ kind: 'repository', name: 'ModA' }], exclude: [], ignore: ['Textures/a.dds'], flags: new Map(), files: new Map() });
    const client = new InMemoryMEditClient();
    client.setCommandHandler('build', () => Promise.resolve({ landed: [{ ...builtOf('ModA'), packed: ['Textures/a.dds', 'Textures/b.dds'] }], refused: [] }));
    const fake = fakeInstanceAdapter(readingFixture({ modFolders: modFoldersIn(join(root, 'mods'), 'ModA'), sourceRepositories: repositoriesOf(SOURCES) }));

    await sourceCommands({ client, adapter: fake.adapter, saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() }).build(['ModA']);

    expect(fake.calls.filter((call) => call.verb === 'trashFileIn')).toEqual([{ verb: 'trashFileIn', folder: folderOf('ModA'), relativePath: 'Textures/b.dds' }]);
  });

  it('names a mod whose manifest could not be written', async () => {
    await rm(folderOf('ModA'), { recursive: true });
    const client = new InMemoryMEditClient();
    buildingEach(client);

    const outcome = await sourceCommands({ client, adapter: fakeAdapter(), saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() }).build(['ModA']);

    expect(outcome).toEqual({
      landed: [{ ...landedOf('ModA'), failure: expect.stringMatching(/^The build could not write its manifest: /) as unknown }], refused: [],
    });
  });

  it('names a mod a file of which it vouches for could not be hashed, and writes no manifest', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandHandler('build', () => Promise.resolve({ landed: [{ ...builtOf('ModA'), made: [{ path: 'a.esp', vouchedFor: true }] }], refused: [] }));
    const adapter = fakeAdapter({ folderFiles: new Map([[folderOf('ModA'), ['a.esp']]]) });

    const outcome = await sourceCommands({ client, adapter, saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() }).build(['ModA']);

    expect(outcome).toEqual({
      landed: [{ ...landedOf('ModA'), failure: `The build could not write its manifest: 'a.esp' could not be read: no answer fixed for ${join(folderOf('ModA'), 'a.esp')}` }], refused: [],
    });
    expect(await readdir(folderOf('ModA'))).toEqual([]);
  });
});

describe('sourceCommands build over a folder it cannot read', () => {
  it('refuses the mod before mEdit builds, naming why', async () => {
    const unreadable = { ...fakeAdapter(), folderValue: () => Promise.reject(new Error('EACCES')) };
    const client = new InMemoryMEditClient();

    const outcome = await sourceCommands({ client, adapter: unreadable, saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() }).build(['ModA']);

    expect([outcome, client.calls]).toEqual([{ landed: [], refused: [{ item: 'ModA', reason: 'was not built: its folder could not be read: EACCES.' }] }, []]);
  });
});

describe('sourceCommands initSourceMod', () => {
  const modsAt = (answers: InstanceAnswers = {}) => fakeInstanceAdapter(readingFixture({ sourceRepositories: repositoriesOf(SOURCES) }), answers).adapter;
  const FOLDER = '/instance/mods/ModA';
  const hashed = (files: Record<string, string>, folder = FOLDER): InstanceAnswers => ({
    folderFiles: new Map([[folder, Object.keys(files)]]),
    hashes: new Map(Object.entries(files).map(([path, hash]) => [join(folder, path), { size: 1, hash }])),
  });
  const committing = () => {
    const client = new InMemoryMEditClient();
    const handed: ModToInitSourceMod[] = [];
    client.setCommandHandler('initSourceMod', (mods) => { handed.push(...mods); return Promise.resolve({ landed: [], refused: [] }); });
    return { client, handed };
  };
  it('hands mEdit each mod\'s repository: as its assets each file its installation file does not yield with its bytes but those compile writes, and a build file that copies every other file by the file or folder at the root holding it, then compiles each plugin (plugins.md, Version in git, story 2)', async () => {
    const { client, handed } = committing();
    const pack = { path: '/downloads/Pack.7z', page: undefined, size: 7, hash: 'H', entries: [{ path: 'textures/a.dds', hash: 'A' }] };
    const adapter = modsAt({
      ...hashed({ 'ModA.esp': 'P', 'Strings/ModA_en.strings': 'S', 'meta.ini': 'M', 'textures/a.dds': 'A', 'scripts/b.pex': 'B', 'ModA.manifest.json': 'X' }),
      installations: new Map([['ModA', { kind: 'read', answer: pack }]]), metadata: new Map([['ModA', { version: '1.2.3' }]]),
    });

    await sourceCommands({ client, adapter, saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() }).initSourceMod(['ModA'], { commit: true });

    const [mod] = handed;
    expect(mod).toMatchObject({ name: 'ModA', repository: { sourceFolder: '/source/ModA', assets: ['scripts/b.pex'] } });
    expect(mod?.repository.buildFile).toBe('{"version":1,"steps":[\n{"copy":["scripts","textures"]},\n{"compile":["ModA.esp"]}\n]}\n');
  });

  it.each(['build.json', 'Plugin-Source/notes.txt', '.gitignore'])('refuses a mod that holds %s, where its source folder holds its own, handing mEdit nothing', async (path) => {
    const { client, handed } = committing();
    const adapter = modsAt(hashed({ 'ModA.esp': 'P', [path]: 'X' }));

    const outcome = await sourceCommands({ client, adapter, saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() }).initSourceMod(['ModA'], { commit: true });

    expect([handed, outcome.refused]).toEqual([[], [{ item: 'ModA', reason: `its '${path.split('/')[0] ?? path}' is where its source folder holds its own` }]]);
  });

  it('names the repository in each committed mod\'s manifest, and none of the mod\'s metadata, so the mod is a source mod (commands.md, version in git)', async () => {
    const folder = folderOf('ModA');
    const client = new InMemoryMEditClient();
    client.setCommandHandler('initSourceMod', () => Promise.resolve({ landed: [{ mod: 'ModA', plugins: [] }], refused: [] }));
    const adapter = fakeInstanceAdapter(readingFixture({ modFolders: modFoldersIn(join(root, 'mods'), 'ModA') }), { metadata: new Map([['ModA', { version: '1.2.3' }]]) }).adapter;

    const outcome = await sourceCommands({ client, adapter, saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() }).initSourceMod(['ModA'], { commit: true });

    expect(outcome).toEqual({ landed: [{ mod: 'ModA', plugins: [] }], refused: [] });
    expect(await manifestIn(folder)).toEqual({ manifest: { packages: [{ kind: 'repository', name: 'ModA' }], exclude: [], ignore: [], flags: new Map(), files: new Map() } });
  });

  it.each([[true, 'committed'], [false, 'initialized']])('given commit %s, names a mod whose manifest could not name its repository as %s, never as what did not happen', async (commit, done) => {
    const client = new InMemoryMEditClient();
    client.setCommandHandler('initSourceMod', () => Promise.resolve({ landed: [{ mod: 'ModA', plugins: [] }], refused: [] }));

    const outcome = await sourceCommands({ client, adapter: modsAt(), saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() }).initSourceMod(['ModA'], { commit });

    expect(outcome).toMatchObject({ landed: [{ mod: 'ModA' }], refused: [{ item: 'ModA', reason: expect.stringMatching(new RegExp(`^was ${done}, but its manifest could not name its repository: `)) as unknown }] });
  });

  it('commits as an asset a file its installation file holds with other bytes', async () => {
    const { client, handed } = committing();
    const pack = { path: '/downloads/Pack.7z', page: undefined, size: 7, hash: 'H', entries: [{ path: 'textures/a.dds', hash: 'A' }] };
    const adapter = modsAt({ ...hashed({ 'textures/a.dds': 'edited' }), installations: new Map([['ModA', { kind: 'read', answer: pack }]]) });

    await sourceCommands({ client, adapter, saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() }).initSourceMod(['ModA'], { commit: true });

    expect(handed[0]?.repository.assets).toEqual(['textures/a.dds']);
  });

  it('commits no asset for a file the game folder holds with its bytes', async () => {
    const { client, handed } = committing();
    const file = { path: 'Data/textures/a.dds', hash: 'G', pathInFolder: 'textures/a.dds' };
    const adapter = modsAt({
      ...hashed({ 'textures/a.dds': 'G', 'scripts/b.pex': 'B' }, '/instance/mods/ModC'),
      places: [{ root: '/game', holdsDataFiles: true, depots: [], depotProblems: [], gameFilesTaken: new Map([['ModC', { kind: 'read', answer: { gameFiles: [file], notes: [] } }]]) }],
    });

    await sourceCommands({ client, adapter, saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() }).initSourceMod(['ModC'], { commit: true });

    expect(handed[0]?.repository.assets).toEqual(['scripts/b.pex']);
  });

  it.each<[string, { kind: 'unreadable'; reason: string } | { kind: 'read'; answer: { gameFiles: []; notes: string[] } }, string]>([
    ['cannot be read', { kind: 'unreadable', reason: 'EACCES' }, 'EACCES'],
    ['come with a note', { kind: 'read', answer: { gameFiles: [], notes: ['a game file differs in case'] } }, 'a game file differs in case'],
  ])('refuses a mod whose game files %s, naming why, and commits the rest', async (_case, taken, reason) => {
    const { client, handed } = committing();
    const adapter = modsAt({ places: [{ root: '/game', holdsDataFiles: true, depots: [], depotProblems: [], gameFilesTaken: new Map([['ModC', taken]]) }] });

    const outcome = await sourceCommands({ client, adapter, saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() }).initSourceMod(['ModC', 'ModF'], { commit: true });

    expect(handed).toMatchObject([{ name: 'ModF' }]);
    expect(outcome).toMatchObject({ refused: [{ item: 'ModC', reason }] });
  });

  it.each<[string, InstanceAnswers, string]>([
    ['a file of whose folder cannot be read', { folderFiles: new Map([[FOLDER, ['a.dds']]]) }, `a file of its folder could not be read: no answer fixed for ${join(FOLDER, 'a.dds')}`],
  ])('refuses a mod %s, naming why, and commits the rest', async (_case, answers, reason) => {
    const { client, handed } = committing();

    const outcome = await sourceCommands({ client, adapter: modsAt(answers), saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() }).initSourceMod(['ModA', 'ModB'], { commit: true });

    expect(handed).toMatchObject([{ name: 'ModB' }]);
    expect(outcome).toMatchObject({ refused: [{ item: 'ModA', reason }] });
  });

  it('does not refuse a mod whose installation file cannot be read: no package yields its files, so each is an asset (modlist-repository.md, Update manifest, story 6)', async () => {
    const { client, handed } = committing();
    const adapter = modsAt({ ...hashed({ 'ModA.esp': 'P', 'scripts/b.pex': 'B' }), installations: new Map([['ModA', { kind: 'unreadable', reason: 'EACCES' }]]) });

    const outcome = await sourceCommands({ client, adapter, saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() }).initSourceMod(['ModA'], { commit: true });

    expect([handed[0]?.repository.assets, outcome.refused]).toEqual([['scripts/b.pex'], []]);
  });

  it.each([true, false])('hands mEdit the mod\'s folder and, given commit %s, that commit (plugins.md, Version in git, stories 1 and 3)', async (commit) => {
    const { client, handed } = committing();

    await sourceCommands({ client, adapter: modsAt(hashed({ 'a.ini': 'I' })), saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() })
      .initSourceMod(['ModA'], { commit });

    expect(handed).toMatchObject([{ name: 'ModA', modFolder: '/instance/mods/ModA', commit }]);
  });

  it('refuses a mod whose name gives it no source folder, naming why', async () => {
    const client = new InMemoryMEditClient();

    const outcome = await sourceCommands({ client, adapter: modsAt({ unsourcedMods: new Set(['Mods/ModA']) }), saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() }).initSourceMod(['Mods/ModA'], { commit: true });

    expect(client.calls).toEqual([]);
    expect(outcome).toEqual({ landed: [], refused: [{ item: 'Mods/ModA', reason: 'its name gives it no source folder' }] });
  });

  it('says it is reading each mod\'s files before mEdit decompiles it', async () => {
    const { client } = committing();
    const heard: unknown[] = [];

    await sourceCommands({ client, adapter: modsAt(), saveUnsaved: savedAll, tasks: recordingTasks(), trash: vi.fn() })
      .initSourceMod(['ModA', 'ModB'], { commit: true, onProgress: (status) => { heard.push(status); } });

    expect(heard).toEqual([
      { mod: 'ModA', modsDone: 0, modsTotal: 2, phase: 'ReadingFiles' }, { mod: 'ModB', modsDone: 1, modsTotal: 2, phase: 'ReadingFiles' },
    ]);
  });
});
