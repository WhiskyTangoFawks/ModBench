import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { watch, type PathLike } from 'node:fs';
import { fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';
import { present } from '../../../ports/present';

vi.mock('vscode', () => fakeVscodeModule());
const real = vi.hoisted(() => ({ rename: undefined as typeof import('node:fs/promises').rename | undefined }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  real.rename = actual.rename;
  return { ...actual, rename: vi.fn(actual.rename) };
});
const actualRename = (from: PathLike, to: PathLike): Promise<void> => present(real.rename, 'the real rename')(from, to);

import { mkdir, mkdtemp, readdir, readFile, rename as fsRename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FomodDialog, InstallationFileReader, InstanceAdapter, InstallPackage } from '../../instanceAdapter';
import type { FomodMove } from '../../../wire/fomodPage';
import { programsOf, SCRIPT_EXTENDER_FOLDERS } from '../../../tables/gamePaths';
import { versionInfo, windowsProgram } from '../../../test/windowsProgram';
import { adapterOver } from '../../../test/mo2/adapterOver';
import { assertOnlyChanged, cloneCorpusFixture, snapshotTree } from '../../../test/mo2/corpusFixture';
import { fakeInstallationFileReader } from '../../../test/fakeInstallationFileReader';
import { FOMOD_PAGE } from '../../../test/fomodDialogDouble';

const MOD = 'New Mod';
const UPGRADED = 'Unofficial Fallout 4 Patch';
const DOWNLOADED_FILE = 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z';
const PAYLOAD = ['Installed.esp', 'textures/added.dds', 'meshes/deep/nested.nif'];
const INSTALLATION_FILE: InstallPackage = { kind: 'archive', path: '/elsewhere/Release-1-0.7z' };
const KEYS = {};

const errnoError = (code: string, message: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: ${message}`), { code });

async function filesIn(folder: string): Promise<string[] | null> {
  const files = [...(await snapshotTree(folder)).keys()].sort();
  return files.length === 0 ? null : files;
}

describe('installing a mod through the MO2 Instance adapter', () => {
  let root: string;
  const folder = (mod: string): string => join(root, 'mods', mod);
  const meta = (mod: string): Promise<string> => readFile(join(folder(mod), 'meta.ini'), 'utf8');
  const holding = (files: readonly string[], over: Partial<InstallationFileReader> = {}): InstanceAdapter =>
    adapterOver(root, { installationFileReader: { ...fakeInstallationFileReader(files), ...over } });

  beforeEach(() => {
    root = cloneCorpusFixture();
  });
  afterEach(async () => {
    vi.mocked(fsRename).mockImplementation(actualRename);
    await rm(root, { recursive: true, force: true });
  });

  describe('a new mod', () => {
    it('puts an archive\'s files into a new folder and writes nothing else, its meta holding only the keys it is given', async () => {
      const before = await snapshotTree(root);

      const outcome = await holding([...PAYLOAD, 'meta.ini']).install(INSTALLATION_FILE, { kind: 'new', name: MOD }, { installationFileName: 'Release-1-0.7z' });

      expect(outcome).toEqual({ landed: true });
      expect(await filesIn(folder(MOD))).toEqual([...PAYLOAD, 'meta.ini'].sort());
      expect(await meta(MOD)).toBe('[General]\ngameName=Fallout 4\ninstallationFile=Release-1-0.7z\n');
      assertOnlyChanged(before, await snapshotTree(root), new Set([...PAYLOAD, 'meta.ini'].map((file) => `mods/${MOD}/${file}`)));
    });

    it('records the Nexus file status the new file knows', async () => {
      await holding(PAYLOAD).install(INSTALLATION_FILE, { kind: 'new', name: MOD }, { nexusFileStatus: 3 });

      expect(await meta(MOD)).toBe('[General]\ngameName=Fallout 4\nnexusFileStatus=3\n');
    });

    it('takes the mod ID from the name of the file', async () => {
      await holding(PAYLOAD).install(INSTALLATION_FILE, { kind: 'new', name: MOD }, { installationFileName: 'Release-1234-1-0.7z' });

      expect(await meta(MOD)).toContain('modid=1234');
    });

    it('records the file it was installed from as a pair with the mod\'s Nexus id', async () => {
      await holding([...PAYLOAD, 'meta.ini']).install(INSTALLATION_FILE, { kind: 'new', name: MOD }, { nexusId: '111', installedFileKeys: ['111:222'] });

      expect(await meta(MOD)).toBe('[General]\ngameName=Fallout 4\nmodid=111\n[installedFiles]\n1\\modid=111\n1\\fileid=222\nsize=1\n');
    });

    it('copies a folder\'s files in, leaving the folder where the user put it', async () => {
      const source = await mkdtemp(join(tmpdir(), 'medit-install-source-'));
      try {
        await mkdir(join(source, 'textures'));
        await writeFile(join(source, 'Copied.esp'), 'plugin');
        await writeFile(join(source, 'textures', 'a.dds'), 'texture');
        const before = await snapshotTree(root);

        await holding([]).install({ kind: 'folder', path: source }, { kind: 'new', name: MOD }, KEYS);

        expect(await filesIn(folder(MOD))).toEqual(['Copied.esp', 'meta.ini', 'textures/a.dds']);
        assertOnlyChanged(before, await snapshotTree(root), new Set(['Copied.esp', 'meta.ini', 'textures/a.dds'].map((file) => `mods/${MOD}/${file}`)));
        expect(await filesIn(source)).toEqual(['Copied.esp', 'textures/a.dds']);
      } finally {
        await rm(source, { recursive: true, force: true });
      }
    });

    it('lands nothing and writes nothing for a mod a folder already holds, matched as MO2 matches names, listed or not', async () => {
      await mkdir(folder('Unlisted Folder'));
      await writeFile(join(folder('Unlisted Folder'), 'Kept.esp'), '');
      const before = await snapshotTree(root);

      const outcomes = [
        await holding(PAYLOAD).install(INSTALLATION_FILE, { kind: 'new', name: 'unlisted folder' }, KEYS),
        await holding(PAYLOAD).install(INSTALLATION_FILE, { kind: 'new', name: 'harder vats' }, KEYS),
      ];

      expect(outcomes).toEqual([{ landed: false }, { landed: false }]);
      assertOnlyChanged(before, await snapshotTree(root), new Set());
    });

    it('lands the files by copying when a rename cannot cross volumes', async () => {
      vi.mocked(fsRename).mockRejectedValueOnce(errnoError('EXDEV', 'cross-device link'));

      const outcome = await holding(PAYLOAD).install(INSTALLATION_FILE, { kind: 'new', name: MOD }, KEYS);

      expect(outcome).toEqual({ landed: true });
      expect(await filesIn(folder(MOD))).toEqual([...PAYLOAD, 'meta.ini'].sort());
    });

    it('lands one of two installs of one name at once, and the other finds the folder there', async () => {
      const adapter = holding(PAYLOAD);

      const outcomes = await Promise.all([
        adapter.install(INSTALLATION_FILE, { kind: 'new', name: MOD }, KEYS),
        adapter.install(INSTALLATION_FILE, { kind: 'new', name: MOD }, KEYS),
      ]);

      expect(outcomes).toEqual(expect.arrayContaining([{ landed: true }, { landed: false }]));
      expect(await filesIn(folder(MOD))).toEqual([...PAYLOAD, 'meta.ini'].sort());
    });

    it('rejects with why, and takes its folder with it, when the extraction fails partway', async () => {
      const before = await snapshotTree(root);
      const dies = holding(PAYLOAD, {
        extract: async (installationFilePath, destDir) => {
          await fakeInstallationFileReader(PAYLOAD).extract(installationFilePath, destDir);
          throw new Error('archive is truncated');
        },
      });

      await expect(dies.install(INSTALLATION_FILE, { kind: 'new', name: MOD }, KEYS)).rejects.toThrow('archive is truncated');

      expect(await readdir(join(root, 'mods'))).not.toContain(MOD);
      assertOnlyChanged(before, await snapshotTree(root), new Set());
    });

    it('writes nothing to mods/ while it extracts, and nothing in the instance but its staging folder', async () => {
      const entries = async (): Promise<string[]> => [...await readdir(root), ...(await readdir(join(root, 'mods'))).map((name) => `mods/${name}`)];
      const before = new Set(await entries());
      const seen = new Set<string>();
      const slowly = holding(PAYLOAD, {
        extract: async (installationFilePath, destDir) => {
          for (const path of await entries()) seen.add(path);
          await fakeInstallationFileReader(PAYLOAD).extract(installationFilePath, destDir);
          for (const path of await entries()) seen.add(path);
        },
      });

      await slowly.install(INSTALLATION_FILE, { kind: 'new', name: MOD }, KEYS);

      expect([...seen].filter((path) => !before.has(path) && !path.startsWith('.medit_tmp_'))).toEqual([]);
      expect([...seen].some((path) => path.startsWith('.medit_tmp_'))).toBe(true);
      expect([...await entries()].filter((path) => !before.has(path))).toEqual([`mods/${MOD}`]);
    });
  });

  describe('the root it chooses inside the release, and whether the release is a FOMOD', () => {
    const NO_CHOICES = { fomod: { kind: 'plainCopy', why: 'no choices were given for its steps' } };
    it.each([
      ['a Data folder', ['Data/foo.esp', 'Data/meshes/x.nif'], ['foo.esp', 'meshes/x.nif'], {}],
      ['files at the top', ['foo.esp', 'meshes/x.nif'], ['foo.esp', 'meshes/x.nif'], {}],
      ['a lone wrapper folder', ['MyMod-Main/foo.esp', 'MyMod-Main/textures/x.dds'], ['foo.esp', 'textures/x.dds'], {}],
      ['a Data folder inside a wrapper', ['MyMod-Main/Data/foo.esp'], ['foo.esp'], {}],
      ['a Data folder beside a file', ['Data/foo.esp', 'readme.txt'], ['foo.esp'], {}],
      ['a wrapper beside a file', ['ModA/foo.esp', 'readme.txt'], ['ModA/foo.esp', 'readme.txt'], {}],
      ['a FOMOD', ['fomod/ModuleConfig.xml', '00 Core/Data/foo.esp'], ['00 Core/Data/foo.esp', 'fomod/ModuleConfig.xml'], NO_CHOICES],
      ['a wrapped FOMOD, its config named in any case', ['MyMod/fomod/moduleconfig.xml', 'MyMod/00 Core/foo.esp'], ['00 Core/foo.esp', 'fomod/moduleconfig.xml'], NO_CHOICES],
      ['a FOMOD with more than its config', ['MyMod/fomod/ModuleConfig.xml', 'MyMod/fomod/info.xml', 'MyMod/00 Core/foo.esp'], ['00 Core/foo.esp', 'fomod/ModuleConfig.xml', 'fomod/info.xml'], NO_CHOICES],
      ['a scripted FOMOD, whatever its answer', ['MyMod/fomod/script.cs', 'MyMod/00 Core/foo.esp'], ['00 Core/foo.esp', 'fomod/script.cs'],
        { fomod: { kind: 'plainCopy', why: 'its installer is a script, which Modbench does not run' } }],
      ['a folder named fomod with no config', ['fomod/readme.txt', '00 Core/Data/foo.esp'], ['00 Core/Data/foo.esp', 'fomod/readme.txt'], {}],
    ])('%s', async (_, release, landed, how) => {
      const outcome = await holding(release).install(INSTALLATION_FILE, { kind: 'new', name: MOD }, KEYS, how === NO_CHOICES ? undefined : { kind: 'choices', steps: [] });

      expect(outcome).toEqual({ landed: true, ...how });
      expect(await filesIn(folder(MOD))).toEqual([...landed, 'meta.ini'].sort());
    });

    it.each([
      ...SCRIPT_EXTENDER_FOLDERS, 'meshes',
      'textures', 'materials', 'sound', 'music', 'scripts', 'source', 'interface', 'strings', 'mcm', 'seq', 'video', 'vis',
      'lodsettings', 'shadersfx', 'grass', 'terrain', 'planetdata', 'programs', 'scaleform', 'facegen', 'actors', 'distantlod',
    ])('keeps a lone top-level data folder %s, never taking it for a wrapper', async (name) => {
      await holding([`${name}/x.dat`]).install(INSTALLATION_FILE, { kind: 'new', name: MOD }, KEYS);

      expect(await filesIn(folder(MOD))).toEqual([`${name}/x.dat`, 'meta.ini'].sort());
    });

    it('peels no more than 32 wrapper folders', async () => {
      const levels = Array.from({ length: 40 }, (_, i) => `L${i + 1}`);

      await holding([`${levels.join('/')}/foo.esp`]).install(INSTALLATION_FILE, { kind: 'new', name: MOD }, KEYS);

      expect(await filesIn(folder(MOD))).toEqual([`${levels.slice(32).join('/')}/foo.esp`, 'meta.ini'].sort());
    });
  });

  describe('a FOMOD with its installer\'s answer', () => {
    const SCHEMA = 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://qconsulting.ca/fo3/ModConfig5.0.xsd"';
    const file = (source: string, destination: string): string => `<file source="${source}" destination="${destination}"/>`;
    const PICK = `<installSteps order="Explicit"><installStep name="Main"><optionalFileGroups order="Explicit"><group name="Pick" type="SelectExactlyOne">`
      + '<plugins order="Explicit">'
      + `<plugin name="A"><description/><files>${file('a/A.esp', 'A.esp')}</files><typeDescriptor><type name="Optional"/></typeDescriptor></plugin>`
      + `<plugin name="B"><description/><files>${file('b/B.esp', 'B.esp')}</files><typeDescriptor><type name="Recommended"/></typeDescriptor></plugin>`
      + '</plugins></group></optionalFileGroups></installStep></installSteps>';
    const conditional = (dependency: string, destination: string): string =>
      `<pattern><dependencies>${dependency}</dependencies><files>${file('a/A.esp', destination)}</files></pattern>`;
    let source: string;

    beforeEach(async () => {
      source = await mkdtemp(join(tmpdir(), 'medit-fomod-source-'));
    });
    afterEach(() => rm(source, { recursive: true, force: true }));

    async function fomod(body: string): Promise<InstallPackage> {
      for (const path of ['a/A.esp', 'b/B.esp']) {
        await mkdir(join(source, path, '..'), { recursive: true });
        await writeFile(join(source, path), path);
      }
      await mkdir(join(source, 'fomod'), { recursive: true });
      await writeFile(join(source, 'fomod', 'ModuleConfig.xml'), `<config ${SCHEMA}><moduleName>Test</moduleName>${body}</config>`);
      return { kind: 'folder', path: source };
    }

    it('lands the files its choices select in the mod\'s folder, and nothing of the release else', async () => {
      const before = await snapshotTree(root);

      const outcome = await holding([]).install(await fomod(PICK), { kind: 'new', name: MOD }, KEYS,
        { kind: 'choices', steps: [{ step: 'Main', groups: [{ group: 'Pick', options: ['A'] }] }] });

      expect(outcome).toEqual({ landed: true, fomod: { kind: 'installer', missing: [], notes: [] } });
      assertOnlyChanged(before, await snapshotTree(root), new Set([`mods/${MOD}/A.esp`, `mods/${MOD}/meta.ini`]));
    });

    it('lands the release as it is for Manual', async () => {
      const outcome = await holding([]).install(await fomod(PICK), { kind: 'new', name: MOD }, KEYS, { kind: 'manual' });

      expect(outcome).toEqual({ landed: true, fomod: { kind: 'plainCopy', why: 'Manual was asked for' } });
      expect(await filesIn(folder(MOD))).toEqual(['a/A.esp', 'b/B.esp', 'fomod/ModuleConfig.xml', 'meta.ini']);
    });

    it('writes nothing, and says it was cancelled, when the user cancels the installer', async () => {
      const before = await snapshotTree(root);
      const dialog = { ...FOMOD_PAGE, onMove: (handler: (move: FomodMove) => void) => { setImmediate(() => handler({ kind: 'cancel' })); } };

      const outcome = await holding([]).install(await fomod(PICK), { kind: 'new', name: MOD }, KEYS, { kind: 'dialog', dialog });

      expect(outcome).toEqual({ landed: false, cancelled: true });
      assertOnlyChanged(before, await snapshotTree(root), new Set());
    });

    describe('while its page waits on the user', () => {
      interface HeldPage {
        readonly answer: { kind: 'dialog'; dialog: FomodDialog };
        readonly shown: Promise<void>;
        readonly move: (move: FomodMove) => void;
      }

      function heldPage(): HeldPage {
        let shownNow: () => void = () => undefined;
        const shown = new Promise<void>((resolve) => { shownNow = resolve; });
        let handler: (move: FomodMove) => void = () => undefined;
        const dialog: FomodDialog = { ...FOMOD_PAGE, show: () => shownNow(), onMove: (listener) => { handler = listener; } };
        return { answer: { kind: 'dialog', dialog }, shown, move: (move) => handler(move) };
      }
      const INSTALL: FomodMove = { kind: 'continue', forward: true, stepId: 0 };

      it('installs another mod, as the page is no write', async () => {
        const page = heldPage();
        const installing = holding([]).install(await fomod(PICK), { kind: 'new', name: MOD }, KEYS, page.answer);
        await page.shown;

        const other = await holding(['x.esp']).install(INSTALLATION_FILE, { kind: 'new', name: 'Other' }, KEYS);
        page.move(INSTALL);

        expect(other).toEqual({ landed: true });
        expect(await installing).toMatchObject({ landed: true });
        expect(await filesIn(folder('Other'))).toEqual(['meta.ini', 'x.esp']);
      });

      it.each([
        ['a new mod', { kind: 'new', name: MOD }],
        ['an upgrade', { kind: 'upgrade', name: UPGRADED }],
      ] as const)('writes nothing to mods/ for %s', async (_, target) => {
        const modsBefore = await readdir(join(root, 'mods'));
        const upgradedBefore = await filesIn(folder(UPGRADED));
        const page = heldPage();
        const installing = holding([]).install(await fomod(PICK), target, KEYS, page.answer);
        await page.shown;

        expect(await readdir(join(root, 'mods'))).toEqual(modsBefore);
        expect(await filesIn(folder(UPGRADED))).toEqual(upgradedBefore);
        page.move({ kind: 'manual' });
        await installing;
      });

      it('keeps the name of a new mod from a second install of it', async () => {
        const page = heldPage();
        const installing = holding([]).install(await fomod(PICK), { kind: 'new', name: MOD }, KEYS, page.answer);
        await page.shown;

        expect(await holding(['x.esp']).install(INSTALLATION_FILE, { kind: 'new', name: MOD }, KEYS)).toEqual({ landed: false });
        page.move(INSTALL);
        await installing;
      });

      it('keeps a second install into an upgraded mod out while the page is open, and takes one after', async () => {
        const page = heldPage();
        const installing = holding([]).install(await fomod(PICK), { kind: 'upgrade', name: UPGRADED }, KEYS, page.answer);
        await page.shown;

        expect(await holding(['x.esp']).install(INSTALLATION_FILE, { kind: 'upgrade', name: UPGRADED }, KEYS)).toEqual({ landed: false });
        page.move(INSTALL);
        await installing;

        expect(await holding(['x.esp']).install(INSTALLATION_FILE, { kind: 'upgrade', name: UPGRADED }, KEYS)).toEqual({ landed: true });
      });

      it('answers as a claim its folder fails to meet when an upgrade\'s folder is gone by the time the user chooses Manual', async () => {
        const page = heldPage();
        const installing = holding([]).install(await fomod(PICK), { kind: 'upgrade', name: UPGRADED }, KEYS, page.answer);
        await page.shown;

        await rm(folder(UPGRADED), { recursive: true });
        page.move({ kind: 'manual' });

        expect(await installing).toEqual({ landed: false });
        expect(await readdir(join(root, 'mods'))).not.toContain(UPGRADED);
      });
    });

    it('writes nothing when its installer refuses the choices', async () => {
      const before = await snapshotTree(root);

      await expect(holding([]).install(await fomod(PICK), { kind: 'new', name: MOD }, KEYS, { kind: 'choices', steps: [] }))
        .rejects.toThrow('The choices leave step "Main" unanswered.');

      assertOnlyChanged(before, await snapshotTree(root), new Set());
    });

    it('answers its conditions from the active profile\'s plugins', async () => {
      const game = await mkdtemp(join(tmpdir(), 'medit-fomod-game-'));
      try {
        await mkdir(join(game, 'Data'));
        const adapter = adapterOver(root, { gameFolder: { kind: 'found', root: game, dataFolder: join(game, 'Data') } });

        await adapter.install(await fomod(`<conditionalFileInstalls><patterns>${[
          conditional('<fileDependency file="Patch Mod.esp" state="Active"/>', 'active.esp'),
          conditional('<fileDependency file="NonAsciiRetexture - Addon.esl" state="Inactive"/>', 'inactive.esp'),
          conditional('<fileDependency file="Unofficial Fallout 4 Patch.esp" state="Missing"/>', 'missing.esp'),
          conditional('<fileDependency file="NonAsciiRetexture - Addon.esl" state="Active"/>', 'wrong.esp'),
        ].join('')}</patterns></conditionalFileInstalls>`), { kind: 'new', name: MOD }, KEYS, { kind: 'choices', steps: [] });

        expect(await filesIn(folder(MOD))).toEqual(['active.esp', 'inactive.esp', 'meta.ini', 'missing.esp']);
      } finally {
        await rm(game, { recursive: true, force: true });
      }
    });

    describe('conditions on the versions of the game and its script extender', () => {
      const { game: gameProgram, extenderLoader } = present(programsOf('Fallout4'), 'the programs of the fixture\'s game');
      const program = (fileVersion: readonly number[]): Buffer => windowsProgram({ version: versionInfo(fileVersion) });
      let game: string;

      beforeEach(async () => {
        game = await mkdtemp(join(tmpdir(), 'medit-fomod-game-'));
        await mkdir(join(game, 'Data'));
      });
      afterEach(() => rm(game, { recursive: true, force: true }));

      const installed = async (...dependencies: [string, string][]): Promise<unknown> =>
        adapterOver(root, { gameFolder: { kind: 'found', root: game, dataFolder: join(game, 'Data') } }).install(
          await fomod(`<conditionalFileInstalls><patterns>${dependencies.map(([dependency, destination]) => conditional(dependency, destination)).join('')}</patterns></conditionalFileInstalls>`),
          { kind: 'new', name: MOD }, KEYS, { kind: 'choices', steps: [] },
        );

      it('answers them from the versions of the game\'s program and the extender\'s loader in the game folder', async () => {
        await writeFile(join(game, gameProgram), program([1, 10, 163, 0]));
        await writeFile(join(game, extenderLoader), program([0, 0, 6, 23]));

        await installed(
          ['<gameDependency version="1.10.163.0"/>', 'game.esp'],
          ['<gameDependency version="1.10.164"/>', 'newer-game.esp'],
          ['<foseDependency version="0.0.6.23"/>', 'extender.esp'],
          ['<foseDependency version="0.0.7"/>', 'newer-extender.esp'],
        );

        expect(await filesIn(folder(MOD))).toEqual(['extender.esp', 'game.esp', 'meta.ini']);
      });

      it('reads a script extender whose loader the game folder lacks as MO2 does, as version 0', async () => {
        await writeFile(join(game, gameProgram), program([1, 10, 163, 0]));

        await installed(['<foseDependency version="0.0"/>', 'any-extender.esp'], ['<foseDependency version="0.0.6.23"/>', 'extender.esp']);

        expect(await filesIn(folder(MOD))).toEqual(['any-extender.esp', 'meta.ini']);
      });

      it.each<[string, Buffer | undefined, Buffer | undefined, string]>([
        ['the game\'s program the game folder lacks', undefined, undefined, `the game's version, which could not be read: ${gameProgram} is not in the game folder`],
        ['a game program with no version resource', windowsProgram(), undefined, `the game's version, which could not be read: ${gameProgram} has no version resource`],
        ['an extender loader that is no Windows program', program([1, 10, 163, 0]), Buffer.from('not a program'),
          `the script extender's version, which could not be read: ${extenderLoader} is not a Windows program`],
      ])('refuses, naming %s', async (_, gameBytes, loaderBytes, unread) => {
        if (gameBytes !== undefined) await writeFile(join(game, gameProgram), gameBytes);
        if (loaderBytes !== undefined) await writeFile(join(game, extenderLoader), loaderBytes);

        await expect(installed(['<gameDependency version="1.10.163.0"/>', 'game.esp'], ['<foseDependency version="0.0.6.23"/>', 'extender.esp']))
          .rejects.toThrow(`The FOMOD's conditions read ${unread}.`);
      });
    });
  });

  describe('an upgrade', () => {
    beforeEach(async () => {
      await writeFile(join(folder(UPGRADED), '.gitignore'), 'shipped');
      await writeFile(join(folder(UPGRADED), 'Old.esp'), '');
      await mkdir(join(folder(UPGRADED), 'plugin-source', 'shipped'), { recursive: true });
      await writeFile(join(folder(UPGRADED), 'plugin-source', 'shipped', 'Old.json'), '');
    });

    it('replaces the folder\'s files other than its manifest, and leaves the mod\'s repository beside mods/ as it was', async () => {
      const repository = join(root, 'source', UPGRADED);
      await mkdir(join(repository, '.git'), { recursive: true });
      await writeFile(join(repository, '.git', 'HEAD'), 'ref');
      const before = await snapshotTree(repository);

      const outcome = await holding(['New.esp']).install(INSTALLATION_FILE, { kind: 'upgrade', name: 'unofficial fallout 4 patch' }, KEYS);

      expect(outcome).toEqual({ landed: true });
      expect(await filesIn(folder(UPGRADED))).toEqual(['New.esp', 'meta.ini']);
      expect(await snapshotTree(repository)).toEqual(before);
    });

    it('keeps the mod\'s manifest, which the release does not replace', async () => {
      const manifest = `${UPGRADED}.manifest.json`;
      await writeFile(join(folder(UPGRADED), manifest), '{"kept":true}');

      await holding(['New.esp']).install(INSTALLATION_FILE, { kind: 'upgrade', name: UPGRADED }, KEYS);

      expect(await readFile(join(folder(UPGRADED), manifest), 'utf8')).toBe('{"kept":true}');
    });

    it('unwraps a release nested in a wrapper folder', async () => {
      const outcome = await holding(['Wrapper/Nested.esp']).install(INSTALLATION_FILE, { kind: 'upgrade', name: UPGRADED }, KEYS);

      expect(outcome).toEqual({ landed: true });
      expect(await filesIn(folder(UPGRADED))).toEqual(['Nested.esp', 'meta.ini']);
    });

    it('lands a release holding .git, .gitignore and plugin-source as any content', async () => {
      await holding(['.git/HEAD', '.gitignore', 'plugin-source/released.json']).install(INSTALLATION_FILE, { kind: 'upgrade', name: UPGRADED }, KEYS);

      expect(await filesIn(folder(UPGRADED))).toEqual(['.git/HEAD', '.gitignore', 'meta.ini', 'plugin-source/released.json']);
    });

    it('sets the keys it is given over the meta the mod had, keeping each value they leave out, and never over a meta the release ships', async () => {
      await holding(['meta.ini']).install(INSTALLATION_FILE, { kind: 'upgrade', name: UPGRADED }, { version: '2.2' });

      expect(await meta(UPGRADED)).toBe(
        `[General]\r\ngameName=Fallout 4\r\nmodid=4598\r\nversion=2.2\r\ncategory="-1,"\r\ninstallationFile=${DOWNLOADED_FILE}\r\n`,
      );
    });

    it.each([
      ['keeps the status the mod carried when the new file knows none', undefined, 'nexusFileStatus=3'],
      ['replaces it when the new file knows one', 5, 'nexusFileStatus=5'],
    ])('%s', async (_, status, expected) => {
      await holding(['New.esp']).install(INSTALLATION_FILE, { kind: 'upgrade', name: UPGRADED }, { nexusFileStatus: 3 });

      await holding(['New.esp']).install(INSTALLATION_FILE, { kind: 'upgrade', name: UPGRADED }, { nexusFileStatus: status });

      const text = await meta(UPGRADED);
      expect(text).toContain(expected);
      expect(text.match(/nexusFileStatus=/g)).toHaveLength(1);
    });

    it('lands nothing and writes nothing for a mod no folder holds', async () => {
      const before = await snapshotTree(root);

      const outcome = await holding(PAYLOAD).install(INSTALLATION_FILE, { kind: 'upgrade', name: 'Vanished Mod' }, KEYS);

      expect(outcome).toEqual({ landed: false });
      assertOnlyChanged(before, await snapshotTree(root), new Set());
    });

    it('leaves the folder as it was when the extraction fails', async () => {
      const before = await snapshotTree(root);
      const dies = holding(PAYLOAD, {
        extract: async (installationFilePath, destDir) => {
          await fakeInstallationFileReader(PAYLOAD).extract(installationFilePath, destDir);
          throw new Error('archive is truncated');
        },
      });

      await expect(dies.install(INSTALLATION_FILE, { kind: 'upgrade', name: UPGRADED }, KEYS)).rejects.toThrow('archive is truncated');

      assertOnlyChanged(before, await snapshotTree(root), new Set());
    });

    it('says when it fails part way, naming the mod and what failed, and that nothing was rolled back', async () => {
      vi.mocked(fsRename).mockRejectedValueOnce(errnoError('EACCES', 'permission denied'));

      await expect(holding(PAYLOAD).install(INSTALLATION_FILE, { kind: 'upgrade', name: UPGRADED }, KEYS)).rejects.toThrow(
        `Upgrading "${UPGRADED}" failed partway and was not rolled back: EACCES: permission denied`,
      );
    });

    it('keeps the folder itself, so a watcher armed on it still hears a write after the upgrade', async () => {
      const heard: string[] = [];
      const watcher = watch(folder(UPGRADED), (_, name) => { if (name !== null) heard.push(name); });
      try {
        await holding(PAYLOAD).install(INSTALLATION_FILE, { kind: 'upgrade', name: UPGRADED }, KEYS);

        await writeFile(join(folder(UPGRADED), 'after-upgrade.txt'), 'x');
        await vi.waitFor(() => expect(heard).toContain('after-upgrade.txt'));
      } finally {
        watcher.close();
      }
    });
  });
});
