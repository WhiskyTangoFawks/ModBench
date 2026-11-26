import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { filesWinningFirst, type GameFolder, type ModlistEntry, type OriginFile, type PluginsProvided } from '../instanceAdapter';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { adapterOver } from '../../test/mo2/adapterOver';
import { onPosix } from '../../test/platform';
import { instanceOnDisk } from './instanceOnDisk';

vi.mock('vscode', () => fakeVscodeModule());

const file = (relativePath: string, overrides: Partial<OriginFile> = {}): OriginFile =>
  ({ relativePath, path: `/x/${relativePath}`, sourcePath: `/x/${relativePath}`, excluded: false, markedExcluded: false, includedPath: relativePath, ...overrides });
const mod = (name: string, enabled = true): ModlistEntry => ({ kind: 'mod', name, enabled });

describe('the origins that provide files, winning first', () => {
  it('lists Overwrite, then each enabled mod in mod order, each with the files nothing excludes', () => {
    const files = new Map([['A', [file('a.esp'), file('hidden.esp', { excluded: true })]], ['B', [file('b.esp')]], ['Off', [file('off.esp')]]]);
    const order: ModlistEntry[] = [mod('A'), { kind: 'separator', name: 'S', enabled: true }, mod('Off', false), mod('B')];

    const listed = filesWinningFirst(order, [file('o.esp')], (name) => files.get(name) ?? []);

    expect(listed.map(({ origin, files: kept }) => [origin, kept.map((f) => f.relativePath)])).toEqual([
      [{ kind: 'runtimeOutput' }, ['o.esp']],
      [{ kind: 'mod', name: 'A' }, ['a.esp']],
      [{ kind: 'mod', name: 'B' }, ['b.esp']],
    ]);
  });
});

describe('the plugins each origin provides', () => {
  let instance: string;
  let game: string;
  beforeEach(async () => {
    instance = await instanceOnDisk({ 'profiles/Default/modlist.txt': '+M\n' });
    game = await mkdtemp(join(tmpdir(), 'provided-game-'));
    await mkdir(join(game, 'Data'));
  });
  afterEach(async () => {
    await rm(instance, { recursive: true, force: true });
    await rm(game, { recursive: true, force: true });
  });

  const holding = async (files: Readonly<Record<string, string>>): Promise<void> => {
    await Promise.all(Object.entries(files).map(async ([path, text]) => {
      await mkdir(dirname(join(instance, path)), { recursive: true });
      await writeFile(join(instance, path), text);
    }));
  };
  const providedOver = async (gameFolder: GameFolder = { kind: 'found', root: game, dataFolder: join(game, 'Data') }): Promise<PluginsProvided | undefined> => {
    let provided: PluginsProvided | undefined;
    await adapterOver(instance, { gameFolder }).changePluginOrderOverProvided('Default', (_order, handed) => { provided = handed; return []; });
    return provided;
  };
  const pluginsOf = async (): Promise<unknown> => {
    const provided = await providedOver();
    return provided?.kind === 'listed' ? provided.plugins : provided;
  };

  it('keys each plugin at an origin\'s root as the game compares names, at the spelling of the first copy', async () => {
    await holding({ 'overwrite/A.esp': '', 'mods/M/a.esp': '', 'store/abc123.esp': '' });
    await symlink(join(instance, 'store', 'abc123.esp'), join(instance, 'mods', 'M', 'Zeta.esp'));

    expect(await pluginsOf()).toEqual(new Map([['a.esp', 'A.esp'], ['zeta.esp', 'Zeta.esp']]));
  });

  it('leaves out a file that is not a plugin, and a plugin below an origin\'s root', async () => {
    await holding({ 'mods/M/readme.txt': '', 'mods/M/Optional/B.esp': '' });

    expect(await pluginsOf()).toEqual(new Map());
  });

  onPosix.describe('(only a file system that tells case apart holds two spellings)', () => {
    it('answers a Data folder plugin no origin provides, at the first of its spellings in code-point order, and an origin\'s copy over the Data folder\'s', async () => {
      await holding({ 'mods/M/MASTER.ESM': '' });
      await Promise.all(['master.esm', 'loose.esp', 'Loose.esp'].map((name) => writeFile(join(game, 'Data', name), '')));

      expect(await pluginsOf()).toEqual(new Map([['master.esm', 'MASTER.ESM'], ['loose.esp', 'Loose.esp']]));
    });
  });

  it('answers why there are none when the Data folder is unresolved', async () => {
    expect(await providedOver({ kind: 'notFound', looked: [], setting: 's' })).toEqual({ kind: 'unresolved' });
  });

  it('answers why there are none when the Data folder is unreadable', async () => {
    await writeFile(join(game, 'NotAFolder'), '');

    expect(await providedOver({ kind: 'found', root: game, dataFolder: join(game, 'NotAFolder') })).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('ENOTDIR') as unknown });
  });

  it('answers the plugins the game loads with no line: the release\'s masters, then its Creation Club list', async () => {
    await writeFile(join(game, 'Fallout4.ccc'), 'ccBGSFO4001-PipBoy(Black).esl\r\n');

    expect(await providedOver()).toMatchObject({
      loadedWithNoLine: [
        'Fallout4.esm', 'DLCRobot.esm', 'DLCworkshop01.esm', 'DLCCoast.esm', 'DLCworkshop02.esm', 'DLCworkshop03.esm', 'DLCNukaWorld.esm', 'ccBGSFO4001-PipBoy(Black).esl',
      ],
    });
  });
});
