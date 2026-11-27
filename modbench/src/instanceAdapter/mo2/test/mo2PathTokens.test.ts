import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';
import { NO_DETECTORS } from '../../../test/noDetectors';
import { adapterOver, type AdapterAnswers } from '../../../test/mo2/adapterOver';
import { fileProblemsFake } from '../../../test/fileProblemsFake';
import { adapterAsBuilt } from '../../test/instanceOnDisk';
import { onPosix, onWindows } from '../../../test/platform';

vi.mock('vscode', () => fakeVscodeModule());
const smudge = vi.hoisted(() => ({ beforeRun: vi.fn<() => void>() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const promised: (file: string, args: string[], options: unknown) => Promise<unknown> = promisify(actual.execFile);
  return {
    ...actual,
    execFile: Object.assign(vi.fn(actual.execFile), {
      [promisify.custom]: (file: string, args: string[], options: unknown) => {
        if (args.includes('cat-file') && args.includes('--filters')) smudge.beforeRun();
        return promised(file, args, options);
      },
    }),
  };
});


const made: string[] = [];

beforeEach(() => {
  smudge.beforeRun.mockReset();
});

afterEach(async () => {
  await Promise.all(made.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function folder(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `modbench-path-tokens-${name}-`));
  made.push(path);
  return path;
}

async function gameFolder(): Promise<string> {
  const game = await folder('game');
  await mkdir(join(game, 'Data'));
  return game;
}

const PUBLISHER_FILE = 'compiler_settings.json';

const steamAt = (game: string): NonNullable<AdapterAnswers['detectors']> => ({ ...NO_DETECTORS, paths: () => Promise.resolve({ dataFolder: join(game, 'Data') }) });

async function put(root: string, path: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

const onWineDrive = (path: string, separator: string): string =>
  (process.platform === 'win32' ? path : `Z:${path}`).split(/[\\/]/).join(separator);

const SETTINGS = (lines: readonly string[]): string => ['[General]\r\ngameName=Fallout 4\r\nselected_profile=Default', ...lines, ''].join('\r\n');

async function instanceRepository(lines: readonly string[], game?: string, name = 'instance') {
  const root = await folder(name);
  await put(root, 'ModOrganizer.ini', SETTINGS(lines));
  await put(root, 'profiles/Default/modlist.txt', '');
  await mkdir(join(root, 'mods'));
  git(root, 'init', '--quiet');
  git(root, 'config', 'core.autocrlf', 'false');
  return { root, adapter: adapterOver(root, { gameFolderSettingValue: game }) };
}

const objectsIn = async (root: string): Promise<string[]> => (await readdir(join(root, '.git', 'objects'), { recursive: true })).sort();

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

const programsIn = async (root: string): Promise<[string, string][]> => {
  const folder = join(root, '.git', 'modbench');
  return Promise.all((await readdir(folder)).sort().map(async (name): Promise<[string, string]> => [name, await readFile(join(folder, name), 'utf8')]));
};

const held = (root: string, path: string): string => {
  git(root, 'add', '--', path);
  return git(root, 'cat-file', 'blob', `:${path}`);
};

describe('the MO2 adapter\'s path tokens', () => {
  it('holds the instance folder by a token, however MO2 spells it, though its name holds letters outside ASCII', async () => {
    const { root, adapter } = await instanceRepository([], undefined, 'Jörg');
    await put(root, 'ModOrganizer.ini', SETTINGS([
      `forward=${onWineDrive(root, '/')}/tools/xEdit.exe`,
      `back=${onWineDrive(root, '\\')}\\tools`,
      `escaped=\\"${onWineDrive(root, '\\\\')}\\\\\\"`,
      `itself=${onWineDrive(root, '\\\\')}`,
      `doubled=@ByteArray(${onWineDrive(root, '\\\\').replace('\\\\', '\\\\\\\\')}\\\\Stock Game)`,
      `paths=${onWineDrive(root, '/')}/a,${onWineDrive(root, '/')}/b`,
    ]));

    await adapter.writePathTokens();

    expect(held(root, 'ModOrganizer.ini')).toBe(SETTINGS([
      'forward={instance folder:/}/tools/xEdit.exe',
      'back={instance folder:\\}\\tools',
      'escaped=\\"{instance folder:\\\\}\\\\\\"',
      'itself={instance folder:\\\\}',
      'doubled=@ByteArray({instance folder:\\\\\\\\}\\\\Stock Game)',
      'paths={instance folder:/}/a,{instance folder:/}/b',
    ]));
  });

  it('holds a mod\'s meta.ini by its tokens, for a mod whose whole folder the repository holds', async () => {
    const { root, adapter } = await instanceRepository([]);
    await put(root, 'mods/ModA/meta.ini', `[General]\r\ninstallationFile=${onWineDrive(root, '/')}/downloads/x.7z\r\n`);

    await adapter.writePathTokens();

    expect(held(root, 'mods/ModA/meta.ini')).toBe('[General]\r\ninstallationFile={instance folder:/}/downloads/x.7z\r\n');
  });

  it('holds the game folder by its own token', async () => {
    const game = await gameFolder();
    const { root, adapter } = await instanceRepository([], game);
    await put(root, 'ModOrganizer.ini', SETTINGS([`gamePath=@ByteArray(${onWineDrive(game, '\\\\')})`]));

    await adapter.writePathTokens();

    expect(held(root, 'ModOrganizer.ini')).toBe(SETTINGS(['gamePath=@ByteArray({game folder:\\\\})']));
  });

  it('holds a game folder inside the instance folder by the instance folder\'s token', async () => {
    const { root } = await instanceRepository([]);
    await mkdir(join(root, 'Stock Game', 'Data'), { recursive: true });
    await put(root, 'profiles/Default/Fallout4Custom.INI', `sPath=${onWineDrive(join(root, 'Stock Game'), '\\')}\r\n`);

    await adapterOver(root, { gameFolderSettingValue: join(root, 'Stock Game') }).writePathTokens();

    expect(held(root, 'profiles/Default/Fallout4Custom.INI')).toBe('sPath={instance folder:\\}\\Stock Game\r\n');
  });

  it('keeps the game folder\'s own token once the repository holds it, though the game folder then moves into the instance folder', async () => {
    const game = await gameFolder();
    const { root, adapter } = await instanceRepository([], game);
    await put(root, 'ModOrganizer.ini', SETTINGS([`gamePath=@ByteArray(${onWineDrive(game, '\\\\')})`]));
    await adapter.writePathTokens();
    held(root, 'ModOrganizer.ini');
    await mkdir(join(root, 'Stock Game', 'Data'), { recursive: true });
    await put(root, 'ModOrganizer.ini', SETTINGS([`gamePath=@ByteArray(${onWineDrive(join(root, 'Stock Game'), '\\\\')})`]));

    await adapterOver(root, { gameFolderSettingValue: join(root, 'Stock Game') }).writePathTokens();

    expect(held(root, 'ModOrganizer.ini')).toBe(SETTINGS(['gamePath=@ByteArray({game folder:\\\\})']));
  });

  it('shows each committed file to a diff with this machine\'s paths', async () => {
    const { root, adapter } = await instanceRepository([]);
    const written = SETTINGS([`path=${onWineDrive(root, '/')}/x.exe`]);
    await put(root, 'ModOrganizer.ini', written);
    await adapter.writePathTokens();
    git(root, 'add', '--', 'ModOrganizer.ini');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'paths');

    expect([git(root, 'show', '--textconv', 'HEAD:ModOrganizer.ini'), git(root, 'status', '--porcelain', '--', 'ModOrganizer.ini')]).toEqual([written, '']);
  });

  describe('a value the filter blanks or drops', () => {
    const commit = (root: string, file: string): void => {
      git(root, 'add', '--', file);
      git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'machine');
    };
    const RECENT = ['[recentDirectories]', '1\\name=Mod', '1\\directory=D:/Elsewhere'];

    it.each([
      ['a blanked value', PUBLISHER_FILE, (edit: string) => `{\n"Source":"${edit}",\n"OutputFile":"C:\\\\out\\\\list.out"\n}`],
      ['a dropped section before another', 'ModOrganizer.ini', (edit: string) => SETTINGS([...RECENT, '[Settings]', `style=${edit}`])],
      ['a dropped section at the end', 'ModOrganizer.ini', (edit: string) => SETTINGS(['[Settings]', `style=${edit}`, ...RECENT])],
    ])('shows git diff only a change beside %s', async (_what, file, text) => {
      const { root, adapter } = await instanceRepository([]);
      await put(root, file, text('before'));
      await adapter.writePathTokens();
      commit(root, file);
      await put(root, file, text('after'));

      const changed = git(root, 'diff', '-U0').split('\n').filter((line) => /^[-+][^-+]/.test(line));
      expect(changed.map((line) => line.slice(0, 1) + (line.includes('before') ? 'before' : line.includes('after') ? 'after' : line))).toEqual(['-before', '+after']);
    });

    it.each([
      ['a blanked value', PUBLISHER_FILE, () => JSON.stringify({ Source: '{x}', OutputFile: 'C:\\out\\list.out' })],
      ['a dropped section', 'ModOrganizer.ini', () => SETTINGS([...RECENT, '[Settings]', 'style=dark'])],
      ['a dropped section at the end', 'ModOrganizer.ini', () => SETTINGS(['[Settings]', 'style=dark', ...RECENT])],
    ])('puts %s back on checkout as this machine\'s own', async (_what, file, text) => {
      const { root, adapter } = await instanceRepository([]);
      await put(root, file, text());
      await adapter.writePathTokens();
      commit(root, file);
      await rm(join(root, file));

      git(root, 'checkout', '--', file);

      expect(await readFile(join(root, file), 'utf8')).toBe(text());
    });

    it('puts a dropped section back at the end of a file that lacks the header of the section that followed it', async () => {
      const { root, adapter } = await instanceRepository([]);
      await put(root, 'ModOrganizer.ini', SETTINGS([...RECENT, '[Settings]', 'style=dark']));
      await adapter.writePathTokens();
      await put(root, 'ModOrganizer.ini', SETTINGS([]));
      commit(root, 'ModOrganizer.ini');
      await rm(join(root, 'ModOrganizer.ini'));

      git(root, 'checkout', '--', 'ModOrganizer.ini');

      expect(await readFile(join(root, 'ModOrganizer.ini'), 'utf8')).toBe(SETTINGS(RECENT));
    });

    it.each([
      ['a blanked value', PUBLISHER_FILE, (output: string) => JSON.stringify({ Source: '{x}', OutputFile: output, Ignore: ['.git', '.env'] })],
      ['a dropped section', 'ModOrganizer.ini', (directory: string) => SETTINGS(['[recentDirectories]', `1\\directory=${directory}`, '[Settings]', 'style=dark'])],
    ])('puts %s back as this machine\'s latest after the watch hears it change', async (_what, file, text) => {
      const { root, adapter } = await instanceRepository([]);
      await put(root, 'profiles/Default/plugins.txt', '');
      await put(root, file, text('C:\\old'));
      await adapter.writePathTokens();
      await put(root, file, text('C:\\new'));
      await adapter.reading();
      commit(root, file);
      await rm(join(root, file));

      git(root, 'checkout', '--', file);

      expect(await readFile(join(root, file), 'utf8')).toBe(text('C:\\new'));
    });

    it('puts a dropped section back once into a file that holds it and a token', async () => {
      const { root, adapter } = await instanceRepository([]);
      await put(root, 'ModOrganizer.ini', SETTINGS([...RECENT, '[Settings]', 'path={instance folder:/}/x']));

      await adapter.writePathTokens();

      expect(await readFile(join(root, 'ModOrganizer.ini'), 'utf8')).toBe(SETTINGS([...RECENT, '[Settings]', `path=${onWineDrive(root, '/')}/x`]));
    });
  });

  it('leaves its filter programs as its own write has them while a reading of the instance waits', async () => {
    const { root } = await instanceRepository([]);
    const game = await folder('game');
    await mkdir(join(game, 'Data'));
    await put(root, 'profiles/Default/plugins.txt', '');
    await put(root, 'ModOrganizer.ini', SETTINGS([`path=${onWineDrive(game, '/')}/x.exe`]));
    const found = { kind: 'found' as const, root: game, dataFolder: join(game, 'Data') };
    let reading: Promise<unknown> | undefined;
    let untouched: boolean | undefined;
    const adapter = adapterOver(root, {
      gameFolder: async () => {
        if (reading === undefined) {
          const before = await programsIn(root);
          reading = adapter.reading();
          await new Promise((resolve) => setTimeout(resolve, 500));
          untouched = JSON.stringify(before) === JSON.stringify(await programsIn(root));
        }
        return found;
      },
    });

    await adapter.writePathTokens();
    await reading;

    expect(untouched).toBe(true);
  });

  it('takes a file committed before the game folder was found as changed once the game folder is found', async () => {
    const game = await gameFolder();
    const { root } = await instanceRepository([`1\\binary=${onWineDrive(game, '/')}/Fallout4.exe`]);
    await adapterOver(root, {}).writePathTokens();
    const anHourAgo = new Date(Date.now() - 3_600_000);
    await utimes(join(root, 'ModOrganizer.ini'), anHourAgo, anHourAgo);
    git(root, 'add', '--', 'ModOrganizer.ini');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'paths');

    await adapterOver(root, { gameFolderSettingValue: game }).writePathTokens();

    expect(git(root, 'status', '--porcelain', '--', 'ModOrganizer.ini')).toBe(' M ModOrganizer.ini\n');
  });

  it('holds each account MO2 writes in its settings by a token, and a username= line of another section as it is', async () => {
    const { root, adapter } = await instanceRepository([]);
    const keys = ['username', 'password', 'steam_username', 'steam_password', 'nexus_username', 'nexus_password', 'nexus_login', 'nexus_api_key'];
    await put(root, 'ModOrganizer.ini', SETTINGS(['username=x', '[Settings]', ...keys.map((key) => `${key}=Wayne`)]));

    await adapter.writePathTokens();

    expect(held(root, 'ModOrganizer.ini')).toBe(SETTINGS(['username=x', '[Settings]', ...keys.map((key) => `${key}={account}`)]));
  });

  it('holds a downloads folder outside the instance folder by its own token', async () => {
    const outside = await folder('downloads');
    const { root, adapter } = await instanceRepository([]);
    await put(root, 'ModOrganizer.ini', SETTINGS(['[Settings]', `download_directory=${onWineDrive(outside, '/')}`]));

    await adapter.writePathTokens();

    expect(held(root, 'ModOrganizer.ini')).toBe(SETTINGS(['[Settings]', 'download_directory={downloads folder:/}']));
  });

  it('holds a downloads folder inside the instance folder by the instance folder\'s token, though a file no filter covers holds a downloads token', async () => {
    const { root, adapter } = await instanceRepository([]);
    await put(root, 'README.md', 'Set download_directory to {downloads folder}\n');
    git(root, 'add', '--', 'README.md');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'readme');
    await put(root, 'ModOrganizer.ini', SETTINGS(['[Settings]', `download_directory=${onWineDrive(root, '/')}/dl`]));

    await adapter.writePathTokens();

    expect(held(root, 'ModOrganizer.ini')).toBe(SETTINGS(['[Settings]', 'download_directory={instance folder:/}/dl']));
  });

  it('holds the default downloads folder, which the settings do not name, by the instance folder\'s token', async () => {
    const { root, adapter } = await instanceRepository([]);
    await put(root, 'ModOrganizer.ini', SETTINGS([`path=${onWineDrive(join(root, 'downloads'), '/')}/a.7z`]));

    await adapter.writePathTokens();

    expect(held(root, 'ModOrganizer.ini')).toBe(SETTINGS(['path={instance folder:/}/downloads/a.7z']));
  });

  it('puts a clone\'s own downloads folder in place of the downloads token', async () => {
    const outside = await folder('downloads');
    const { clone, adapter } = await cloned((origin) => ['[Settings]', `download_directory=${onWineDrive(outside, '/')}`, `path=${onWineDrive(origin, '/')}/x`]);

    const left = await adapter.writePathTokens();

    expect([left, await readFile(join(clone, 'ModOrganizer.ini'), 'utf8'), git(clone, 'status', '--porcelain')])
      .toEqual([undefined, SETTINGS(['[Settings]', `download_directory=${onWineDrive(join(clone, 'downloads'), '/')}`, `path=${onWineDrive(clone, '/')}/x`]), '']);
  });

  it('drops the folders MO2\'s file dialogs last browsed', async () => {
    const { root, adapter } = await instanceRepository([]);
    await put(root, 'ModOrganizer.ini', SETTINGS(['[recentDirectories]', '1\\name=Mod', '1\\directory=D:/Elsewhere', '[Settings]', 'style=dark']));

    await adapter.writePathTokens();

    expect(held(root, 'ModOrganizer.ini')).toBe(SETTINGS(['[Settings]', 'style=dark']));
  });

  it('holds a username= line in a profile\'s INI as it is', async () => {
    const { root, adapter } = await instanceRepository([]);
    await put(root, 'profiles/Default/Fallout4Custom.ini', '[Settings]\r\nusername=x\r\n');

    await adapter.writePathTokens();

    expect(held(root, 'profiles/Default/Fallout4Custom.ini')).toBe('[Settings]\r\nusername=x\r\n');
  });

  it('keeps its filter programs where every worktree of the repository finds them', async () => {
    const { root } = await instanceRepository([]);
    git(root, 'add', '--', 'profiles');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'start');
    const linked = join(await folder('worktrees'), 'linked');
    git(root, 'worktree', 'add', '--quiet', linked);
    await put(linked, 'ModOrganizer.ini', SETTINGS(['gamePath=C:/Games']));

    await adapterOver(linked, {}).writePathTokens();
    git(root, 'worktree', 'remove', '--force', linked);
    await put(root, 'ModOrganizer.ini', SETTINGS([`path=${onWineDrive(linked, '/')}/x.exe`]));

    expect(held(root, 'ModOrganizer.ini')).toBe(SETTINGS(['path={instance folder:/}/x.exe']));
  });

  it('refuses to stage a file the token filter fails on, rather than hold it as it is', async () => {
    const { root, adapter } = await instanceRepository([]);
    await adapter.writePathTokens();
    git(root, 'config', 'filter.modbench-settings-tokens.clean', 'exit 1');

    expect(() => execFileSync('git', ['add', '--', 'ModOrganizer.ini'], { cwd: root, stdio: 'pipe' })).toThrow(/ModOrganizer\.ini/);
  });

  async function cloned(lines: (origin: string, game: string) => readonly string[], detectors?: AdapterAnswers['detectors'], publisherSettings?: (origin: string, game: string) => string) {
    const game = await gameFolder();
    const { root, adapter } = await instanceRepository([], game);
    await put(root, 'ModOrganizer.ini', SETTINGS(lines(root, game)));
    if (publisherSettings !== undefined) await put(root, PUBLISHER_FILE, publisherSettings(root, game));
    await adapter.writePathTokens();
    git(root, 'add', '--', 'ModOrganizer.ini', ...(publisherSettings === undefined ? [] : [PUBLISHER_FILE]));
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'paths');
    const clone = join(await folder('clone'), 'modlist');
    git(dirname(clone), 'clone', '--quiet', '--config', 'core.autocrlf=false', root, clone);
    await mkdir(join(clone, 'mods'));
    return { clone, adapter: adapterOver(clone, { detectors }), game };
  }

  describe('in the publisher\'s configuration', () => {
    const publisherSettings = (instance: string, game: string): string =>
      JSON.stringify({ Source: instance, Downloads: `${instance}${sep}downloads`, GamePath: game }, null, 2);

    it('holds each folder by its native token, and the working tree by this machine\'s paths', async () => {
      const game = await gameFolder();
      const { root, adapter } = await instanceRepository([], game);
      await put(root, PUBLISHER_FILE, publisherSettings(root, game));

      await adapter.writePathTokens();

      expect([held(root, PUBLISHER_FILE), await readFile(join(root, PUBLISHER_FILE), 'utf8')])
        .toEqual([publisherSettings('{instance folder}', '{game folder}'), publisherSettings(root, game)]);
    });

    it.each([
      ['natively', (folder: string) => folder],
      ['by a Windows program on Wine', (folder: string) => onWineDrive(folder, '\\')],
    ])('puts a clone\'s own folders in place of their tokens, spelt %s, and git holds the clone as committed', async (_spelt, spelt) => {
      const steam = await gameFolder();
      const { clone, adapter } = await cloned(() => [], steamAt(steam), (origin, game) => publisherSettings(spelt(origin), spelt(game)));

      await adapter.writePathTokens();

      expect([await readFile(join(clone, PUBLISHER_FILE), 'utf8'), git(clone, 'status', '--porcelain')])
        .toEqual([publisherSettings(spelt(clone), spelt(steam)), '']);
    });

    it('blanks what it holds of this machine alone', async () => {
      const { root, adapter } = await instanceRepository([]);
      await put(root, PUBLISHER_FILE, JSON.stringify({ Source: root, OutputFile: join(root, 'list.out') }));

      await adapter.writePathTokens();

      expect(held(root, PUBLISHER_FILE)).toBe(JSON.stringify({ Source: '{instance folder}', OutputFile: '' }));
    });

  });

  describe('a file the index or HEAD holds unfiltered', () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 3_600_000 }); });
    afterEach(() => { vi.useRealTimers(); });

    const commit = (root: string): void => { git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'commit'); };

    const stagedAsTextWithNoFilter = (root: string, path: string): void => {
      const blob = git(root, 'hash-object', '-w', '--no-filters', '--', path).trim();
      git(root, 'update-index', '--add', '--cacheinfo', `100644,${blob},${path}`);
    };

    async function problemsOver(file: string, text: (root: string) => string) {
      const game = await gameFolder();
      const { root } = await instanceRepository([]);
      const problems = fileProblemsFake();
      const adapter = adapterAsBuilt(root, { gameFolderSettingValue: game, fileProblems: problems });
      await put(root, 'profiles/Default/plugins.txt', '');
      await writeFile(join(root, file), text(root));
      await adapter.writePathTokens();
      const shown = async () => {
        await adapter.reading();
        return problems.held.get(join(root, file));
      };
      return { root, shown };
    }

    const unfiltered = (holders: string, remedy: string) =>
      [{ line: 1, message: `${holders} this file unfiltered, so a clone gets this machine's own values, such as its paths. ${remedy}` }];

    it('shows the index holding it on the file, until a stage of the whole file', async () => {
      const { root, shown } = await problemsOver(PUBLISHER_FILE, (instance) => JSON.stringify({ Source: instance }));
      stagedAsTextWithNoFilter(root, PUBLISHER_FILE);

      const staged = await shown();
      git(root, 'add', '--', PUBLISHER_FILE);

      expect([staged, await shown()]).toEqual([unfiltered('The index holds', 'Stage the whole file to filter it.'), undefined]);
    });

    it('shows HEAD holding it on the file, until a commit of it filtered', async () => {
      const { root, shown } = await problemsOver('ModOrganizer.ini', (instance) => SETTINGS([`path=${onWineDrive(instance, '/')}/tools`]));
      stagedAsTextWithNoFilter(root, 'ModOrganizer.ini');
      commit(root);

      const committed = await shown();
      git(root, 'add', '--', 'ModOrganizer.ini');
      const restaged = await shown();
      commit(root);

      expect([committed, restaged, await shown()]).toEqual([
        unfiltered('The index and HEAD hold', 'Stage the whole file to filter it, then commit it.'),
        unfiltered('HEAD holds', 'Commit it as staged.'),
        undefined,
      ]);
    });

    it('shows HEAD holding it until HEAD moves off it, though the index stays as it is', async () => {
      const { root, shown } = await problemsOver('ModOrganizer.ini', (instance) => SETTINGS([`path=${onWineDrive(instance, '/')}/tools`]));
      git(root, 'add', '--', 'ModOrganizer.ini');
      commit(root);
      stagedAsTextWithNoFilter(root, 'ModOrganizer.ini');
      commit(root);
      git(root, 'add', '--', 'ModOrganizer.ini');

      const committed = await shown();
      git(root, 'reset', '--soft', 'HEAD~1');

      expect([committed, await shown()]).toEqual([unfiltered('HEAD holds', 'Commit it as staged.'), undefined]);
    });

    it('says a file its filter fails on could not be checked, and checks it again on the next reading', async () => {
      const { root, shown } = await problemsOver(PUBLISHER_FILE, (instance) => JSON.stringify({ Source: instance }));
      git(root, 'add', '--', PUBLISHER_FILE);
      const clean = git(root, 'config', 'filter.modbench-publisher-tokens.clean').trim();
      git(root, 'config', 'filter.modbench-publisher-tokens.clean', 'false');

      const failed = await shown();
      git(root, 'config', 'filter.modbench-publisher-tokens.clean', clean);

      expect([failed?.map(({ message }) => message.startsWith('could not be checked against its filter: ')), await shown()]).toEqual([[true], undefined]);
    });

    it('shows nothing for a file staged filtered with bytes outside UTF-8 while the working tree holds UTF-8', async () => {
      const { root, shown } = await problemsOver('ModOrganizer.ini', () => SETTINGS([]));
      await writeFile(join(root, 'ModOrganizer.ini'), Buffer.from(SETTINGS(['name=Caf\xe9']), 'latin1'));
      git(root, 'add', '--', 'ModOrganizer.ini');
      await writeFile(join(root, 'ModOrganizer.ini'), SETTINGS([]));

      expect(await shown()).toBeUndefined();
    });

    it('shows nothing for a file committed with other line ends than git converts to', async () => {
      const { root, shown } = await problemsOver('ModOrganizer.ini', (instance) => SETTINGS([`path=${onWineDrive(instance, '/')}/tools`]));
      git(root, 'add', '--', 'ModOrganizer.ini');
      commit(root);
      git(root, 'config', 'core.autocrlf', 'true');

      expect(await shown()).toBeUndefined();
    });
  });

  describe('on a clone', () => {
    it('puts the clone\'s own instance folder in place of its path token, and git holds the clone as committed', async () => {
      const { clone, adapter } = await cloned((origin) => [`1\\binary=${onWineDrive(origin, '/')}/tools/xEdit.exe`]);

      const left = await adapter.writePathTokens();

      expect([left, await readFile(join(clone, 'ModOrganizer.ini'), 'utf8'), git(clone, 'status', '--porcelain')])
        .toEqual([undefined, SETTINGS([`1\\binary=${onWineDrive(clone, '/')}/tools/xEdit.exe`]), '']);
    });

    it('holds no account, and git holds the clone as committed', async () => {
      const { clone, adapter } = await cloned(() => ['[Settings]', 'steam_username=Wayne']);

      await adapter.writePathTokens();

      expect([await readFile(join(clone, 'ModOrganizer.ini'), 'utf8'), git(clone, 'status', '--porcelain')])
        .toEqual([SETTINGS(['[Settings]', 'steam_username=']), '']);
    });

    it('writes no object into the repository, writing the path tokens', async () => {
      const { clone, adapter } = await cloned((origin) => [`1\\binary=${onWineDrive(origin, '/')}/tools/xEdit.exe`]);
      await put(clone, 'ModOrganizer.ini', SETTINGS(['1\\binary={instance folder:/}/tools/SSEEdit.exe']));
      const before = await objectsIn(clone);

      await adapter.writePathTokens();

      expect(await objectsIn(clone)).toEqual(before);
    });

    it('finds the game folder where the game path is a path token, and puts it in place of the token', async () => {
      const steam = await gameFolder();
      const { clone, adapter } = await cloned((_origin, game) => [`gamePath=@ByteArray(${onWineDrive(game, '\\\\')})`], steamAt(steam));

      await adapter.writePathTokens();

      expect(await readFile(join(clone, 'ModOrganizer.ini'), 'utf8')).toBe(SETTINGS([`gamePath=@ByteArray(${onWineDrive(steam, '\\\\')})`]));
    });

    it('names a file once as still holding a path token, though an outside write made it edit the file again', async () => {
      const { clone, adapter } = await cloned((_origin, game) => [`gamePath=@ByteArray(${onWineDrive(game, '\\\\')})`]);
      const ini = join(clone, 'ModOrganizer.ini');
      smudge.beforeRun.mockImplementationOnce(() => undefined).mockImplementationOnce(() => { appendFileSync(ini, 'outside=1\r\n'); });

      expect(await adapter.writePathTokens())
        .toBe('ModOrganizer.ini still holds a path token in place of this machine\'s path, because the game folder was not found');
    });
  });

  it('writes nothing in an instance folder that holds no repository', async () => {
    const root = await folder('instance');
    await put(root, 'ModOrganizer.ini', SETTINGS(['1\\binary=C:/Modding/x.exe']));
    const adapter = adapterOver(root, {});

    expect([await adapter.writePathTokens(), await readFile(join(root, 'ModOrganizer.ini'), 'utf8')])
      .toEqual([undefined, SETTINGS(['1\\binary=C:/Modding/x.exe'])]);
  });

  it('leaves the config of a repository that already holds its filters as it is', async () => {
    const { root, adapter } = await instanceRepository([]);
    await adapter.writePathTokens();
    const configFile = async (): Promise<bigint[]> => {
      const { ino, mtimeNs } = await stat(join(root, '.git', 'config'), { bigint: true });
      return [ino, mtimeNs];
    };
    const before = await configFile();

    await adapter.writePathTokens();

    expect(await configFile()).toEqual(before);
  });

  it('holds a file by its tokens though the repository held its filter with another program', async () => {
    const { root, adapter } = await instanceRepository([]);
    git(root, 'config', 'filter.modbench-tokens.clean', 'cat');
    await put(root, 'profiles/Default/Fallout4Custom.ini', `sPath=${onWineDrive(root, '\\')}\\Stock Game\r\n`);

    await adapter.writePathTokens();

    expect(held(root, 'profiles/Default/Fallout4Custom.ini')).toBe('sPath={instance folder:\\}\\Stock Game\r\n');
  });

  it('takes back each filter key to the value the repository held when a write fails', async () => {
    const { root } = await instanceRepository([]);
    git(root, 'config', 'filter.modbench-tokens.clean', 'cat');
    const failing = adapterOver(root, { gameFolder: () => Promise.reject(new Error('the game folder could not be read')) });

    await expect(failing.writePathTokens()).rejects.toThrow('the game folder could not be read');

    expect(git(root, 'config', '--local', '--list').split('\n').filter((line) => line.includes('modbench-'))).toEqual(['filter.modbench-tokens.clean=cat']);
  });

  onPosix.it.skipIf(process.getuid?.() === 0)('(Windows has no POSIX mode bits, and root reads every file) leaves the repository with no filter, no attributes and no config when a first write fails', async () => {
    const { root, adapter } = await instanceRepository([]);
    await put(root, 'profiles/Default/Fallout4Prefs.ini', 'x=1\r\n');
    await chmod(join(root, 'profiles/Default/Fallout4Prefs.ini'), 0o000);

    await expect(adapter.writePathTokens()).rejects.toThrow();

    const config = git(root, 'config', '--local', '--list').split('\n').filter((line) => line.includes('modbench-'));
    expect([config, await readFile(join(root, '.git', 'info', 'attributes'), 'utf8').catch(() => '')]).toEqual([[], '']);
    expect(await exists(join(root, '.git', 'modbench'))).toBe(false);
  });

  onPosix.it.skipIf(process.getuid?.() === 0)('(Windows has no POSIX mode bits, and root reads every file) takes back only the filter a failed write added, and keeps each the repository held', async () => {
    const { root } = await instanceRepository([]);
    await put(root, 'profiles/Default/Fallout4Prefs.ini', 'x=1\r\n');
    await adapterOver(root).writePathTokens();
    git(root, 'config', '--remove-section', 'filter.modbench-publisher-tokens');
    const attributes = join(root, '.git', 'info', 'attributes');
    await writeFile(attributes, (await readFile(attributes, 'utf8')).split('\n').filter((line) => !line.includes('modbench-publisher-tokens')).join('\n'));
    const written = async () => [
      git(root, 'config', '--local', '--list').split('\n').filter((line) => line.includes('modbench-')),
      await readFile(join(root, '.git', 'info', 'attributes'), 'utf8'),
      await programsIn(root),
    ];
    const before = await written();
    await chmod(join(root, 'profiles/Default/Fallout4Prefs.ini'), 0o000);

    await expect(adapterOver(root, {}).writePathTokens()).rejects.toThrow();

    expect(await written()).toEqual(before);
  });

  describe('the token filter, over the instance\'s own folders', () => {
    const tokenHeld = async (written: (root: string) => string): Promise<{ root: string; held: string }> => {
      const { root, adapter } = await instanceRepository([]);
      await put(root, 'ModOrganizer.ini', SETTINGS([written(root)]));
      await adapter.writePathTokens();
      return { root, held: held(root, 'ModOrganizer.ini') };
    };

    it('cleans and smudges folders whose paths no inline program could carry in a Windows command line', async () => {
      const long = (name: string): string => join(tmpdir(), ...Array.from({ length: 12 }, (_, at) => `${name}${at}`.padEnd(40, 'x')));
      const [game, downloads] = [long('game'), long('downloads')];
      const { root } = await instanceRepository([`x=${onWineDrive(downloads, '\\')}\\a.7z`, 'y={game folder:/}/Data']);

      await adapterOver(root, {
        gameFolder: { kind: 'found', root: game, dataFolder: join(game, 'Data') }, downloadsFolder: { kind: 'resolved', downloadsDir: downloads },
      }).writePathTokens();

      const longest = Math.max(...git(root, 'config', '--local', '--list').split('\n').map((line) => line.length));
      expect([longest < 500, await readFile(join(root, 'ModOrganizer.ini'), 'utf8'), held(root, 'ModOrganizer.ini')]).toEqual([
        true,
        SETTINGS([`x=${onWineDrive(downloads, '\\')}\\a.7z`, `y=${onWineDrive(game, '/')}/Data`]),
        SETTINGS(['x={downloads folder:\\}\\a.7z', 'y={game folder:/}/Data']),
      ]);
    });

    it.each([
      ['unquoted in a program\'s arguments', (r: string) => `x=-o ${onWineDrive(r, '\\\\')}\\\\out`, 'x=-o {instance folder:\\\\}\\\\out'],
      ['in a list\'s second entry', (r: string) => `x=${onWineDrive(r, '/')}/a, ${onWineDrive(r, '/')}/b`, 'x={instance folder:/}/a, {instance folder:/}/b'],
      ['after an option\'s colon', (r: string) => `x="-o:${onWineDrive(r, '\\\\')}\\\\out"`, 'x="-o:{instance folder:\\\\}\\\\out"'],
      ['after a semicolon', (r: string) => `x=${onWineDrive(r, '/')}/a;${onWineDrive(r, '/')}/b`, 'x={instance folder:/}/a;{instance folder:/}/b'],
      ['after a comma', (r: string) => `x=${onWineDrive(r, '/')}/a,${onWineDrive(r, '/')}/b`, 'x={instance folder:/}/a,{instance folder:/}/b'],
      ['at a line\'s start', (r: string) => `${onWineDrive(r, '\\')}\\tools`, '{instance folder:\\}\\tools'],
    ])('holds a folder by its token %s', async (_place, written, tokens) => {
      expect((await tokenHeld(written)).held).toBe(SETTINGS([tokens]));
    });

    it.each([
      ['a longer name', '2'],
      ['a space and more', ' Backup'],
      ['a plus', '+old'],
      ['a parenthesis', '(GOG)'],
      ['a letter beyond ASCII', 'é'],
    ])('holds a path whose folder\'s name begins with a folder\'s and goes on with %s as it is', async (_name, more) => {
      const written = (root: string): string => `x=${onWineDrive(root, '/')}${more}/x.exe`;
      const { root, held: tokens } = await tokenHeld(written);

      expect(tokens).toBe(SETTINGS([written(root)]));
    });

    it('holds a downloads folder inside the instance folder by its own token once the repository holds that token', async () => {
      const outside = await folder('downloads');
      const { root, adapter } = await instanceRepository(['[Settings]', `download_directory=${onWineDrive(outside, '/')}`]);
      await adapter.writePathTokens();
      held(root, 'ModOrganizer.ini');
      git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'downloads');
      await mkdir(join(root, 'dl'));
      await put(root, 'ModOrganizer.ini', SETTINGS(['[Settings]', `download_directory=${onWineDrive(join(root, 'dl'), '/')}`]));

      await adapter.writePathTokens();

      expect(held(root, 'ModOrganizer.ini')).toBe(SETTINGS(['[Settings]', 'download_directory={downloads folder:/}']));
    });

    it.each([
      ['{instance folder}\\\\downloads', '\\\\downloads'],
      ['{instance folder}/downloads', '/downloads'],
    ])('puts the folder\'s path, as this system spells it, in place of its token in a native file a commit on another system holds: %s', async (token, rest) => {
      const { root, adapter } = await instanceRepository([]);
      await put(root, PUBLISHER_FILE, `{"x": "${token}"}`);

      await adapter.writePathTokens();

      expect(await readFile(join(root, PUBLISHER_FILE), 'utf8')).toBe(`{"x": ${JSON.stringify(root).slice(0, -1)}${rest}"}`);
    });

    onPosix.describe('(a Wine prefix and a path from the root are POSIX\'s)', () => {
      async function gameInPrefix(): Promise<string> {
        const game = join(await folder('compatdata'), 'pfx', 'drive_c', 'Games', 'Fallout 4');
        await mkdir(join(game, 'Data'), { recursive: true });
        return game;
      }

      it('holds a game folder in a Wine prefix\'s drive C by its token, as a Windows program spells it', async () => {
        const game = await gameInPrefix();
        const { root, adapter } = await instanceRepository(['x=C:\\\\Games\\\\Fallout 4\\\\Data'], game);

        await adapter.writePathTokens();

        expect(held(root, 'ModOrganizer.ini')).toBe(SETTINGS(['x={game folder:\\\\}\\\\Data']));
      });

      it('puts a game folder in a Wine prefix in place of its token, on its drive C', async () => {
        const game = await gameInPrefix();
        const { root, adapter } = await instanceRepository(['x={game folder:\\\\}'], game);

        await adapter.writePathTokens();

        expect(await readFile(join(root, 'ModOrganizer.ini'), 'utf8')).toBe(SETTINGS(['x=C:\\\\Games\\\\Fallout 4']));
      });

      it('holds a game folder in a Wine prefix in a native file by its token', async () => {
        const game = await gameInPrefix();
        const { root, adapter } = await instanceRepository([], game);
        await put(root, PUBLISHER_FILE, `{"x": "${game}"}`);

        await adapter.writePathTokens();

        expect(held(root, PUBLISHER_FILE)).toBe('{"x": "{game folder}"}');
      });

      it.each([
        ['natively', '/mnt/x'],
        ['natively, after a name that ends in a parenthesis', '/mnt/backup (old)'],
      ])('holds a path that only ends in a folder\'s path, spelt %s, as it is', async (_place, before) => {
        const { root, adapter } = await instanceRepository([]);
        const written = `{"x": "${before}${root}/downloads"}`;
        await put(root, PUBLISHER_FILE, written);

        await adapter.writePathTokens();

        expect(held(root, PUBLISHER_FILE)).toBe(written);
      });
    });

    onWindows.describe('(a drive\'s case is Windows\')', () => {
      it('holds a folder on a drive by its token, written in another case', async () => {
        const { held: tokens } = await tokenHeld((root) => `x=${root.toLowerCase().split(sep).join('/')}/x.exe`);

        expect(tokens).toBe(SETTINGS(['x={instance folder:/}/x.exe']));
      });

      it('holds a folder on a drive in a native file, with escaped backslashes in another case, by its token', async () => {
        const { root, adapter } = await instanceRepository([]);
        await put(root, PUBLISHER_FILE, `{"x": ${JSON.stringify(`${root.toLowerCase()}\\downloads`)}}`);

        await adapter.writePathTokens();

        expect(held(root, PUBLISHER_FILE)).toBe('{"x": "{instance folder}\\\\downloads"}');
      });

      it('puts the folder\'s path in place of a token a Windows program on Wine wrote in a native file', async () => {
        const { root, adapter } = await instanceRepository([]);
        await put(root, PUBLISHER_FILE, '{"x": "{instance folder:\\\\}\\\\downloads"}');

        await adapter.writePathTokens();

        expect(await readFile(join(root, PUBLISHER_FILE), 'utf8')).toBe(`{"x": ${JSON.stringify(`${root}\\downloads`)}}`);
      });
    });

    onWindows.describe('(a network share is Windows\')', () => {
      const onShare = async (lines: readonly string[]): Promise<string> => {
        const { root } = await instanceRepository(lines);
        await adapterOver(root, {
          gameFolder: { kind: 'found', root: '\\\\nas\\share\\Games\\Fallout 4', dataFolder: '\\\\nas\\share\\Games\\Fallout 4\\Data' },
          downloadsFolder: { kind: 'resolved', downloadsDir: '\\\\nas\\share\\Downloads' },
        }).writePathTokens();
        return root;
      };

      it.each([
        ['with backslashes', ['x=\\\\nas\\share\\Games\\Fallout 4\\Data'], ['x={game folder:\\}\\Data']],
        ['with forward slashes in another case', ['x=//NAS/share/games/Fallout 4/x.exe'], ['x={game folder:/}/x.exe']],
        ['with escaped backslashes', ['x=\\"\\\\\\\\nas\\\\share\\\\Games\\\\Fallout 4\\\\\\"'], ['x=\\"{game folder:\\\\}\\\\\\"']],
        ['at a line\'s start', ['x', '\\\\nas\\share\\Games\\Fallout 4\\Data'], ['x', '{game folder:\\}\\Data']],
        ['for the downloads folder', ['x=\\\\nas\\share\\Downloads\\a.7z'], ['x={downloads folder:\\}\\a.7z']],
        ['after a drive, which is no share\'s path', ['x=D:\\\\nas\\share\\Games\\Fallout 4\\Data'], ['x=D:\\\\nas\\share\\Games\\Fallout 4\\Data']],
      ])('holds a folder on a network share by its token, %s', async (_place, written, tokens) => {
        expect(held(await onShare(written), 'ModOrganizer.ini')).toBe(SETTINGS(tokens));
      });

      it.each([
        ['with forward slashes', 'x={game folder:/}/tools', 'x=//nas/share/Games/Fallout 4/tools'],
        ['with backslashes', 'x={game folder:\\}\\tools', 'x=\\\\nas\\share\\Games\\Fallout 4\\tools'],
        ['with escaped backslashes', 'x={game folder:\\\\}\\\\tools', 'x=\\\\\\\\nas\\\\share\\\\Games\\\\Fallout 4\\\\tools'],
        ['with the doubled separator\'s token', 'x={game folder:\\\\\\\\}\\\\tools', 'x=\\\\\\\\nas\\\\share\\\\Games\\\\Fallout 4\\\\tools'],
      ])('puts the path of a folder on a network share in place of its token, %s', async (_place, token, written) => {
        expect(await readFile(join(await onShare([token]), 'ModOrganizer.ini'), 'utf8')).toBe(SETTINGS([written]));
      });
    });
  });
});
