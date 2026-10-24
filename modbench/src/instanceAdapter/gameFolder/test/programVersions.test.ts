import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { programVersions, type ProgramVersion } from '../programVersions';
import { programsOf } from '../../../tables/gamePaths';
import { present } from '../../../ports/present';
import { versionInfo, windowsProgram } from '../../../test/windowsProgram';
import type { GameFolder } from '../../instanceAdapter';

const RELEASE = 'Fallout4';
const { game, extenderLoader } = present(programsOf(RELEASE), 'the release\'s programs');
const NOT_FOUND: GameFolder = { kind: 'notFound', looked: [], setting: 'setting' };

type Installed = Buffer | 'a folder' | undefined;

const program = (fileVersion: readonly number[], productVersion?: string): Buffer => windowsProgram({ version: versionInfo(fileVersion, productVersion) });
const read = (version: string): ProgramVersion => ({ kind: 'read', version });

describe('the versions of the game\'s and its script extender\'s programs, as MO2 reads them', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'program-versions-'));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const install = async (name: string, installed: Installed): Promise<void> => {
    if (installed === 'a folder') await mkdir(join(root, name));
    else if (installed !== undefined) await writeFile(join(root, name), installed);
  };

  it.each<[string, Installed, Installed, ProgramVersion, ProgramVersion]>([
    ['each one\'s file version', program([1, 10, 163, 0], '9.9'), program([0, 0, 6, 23]), read('1.10.163.0'), read('0.0.6.23')],
    ['the game\'s product version where its file version starts 1.0.0, and the extender\'s file version alone',
      program([1, 0, 0, 0], '1.7.23.0'), program([1, 0, 0, 0], '2.0'), read('1.7.23.0'), read('1.0.0.0')],
    ['the game\'s file version of 1.0.0 where it names no product version', program([1, 0, 0, 7]), program([1, 0, 0, 7]), read('1.0.0.7'), read('1.0.0.7')],
    ['each program the game folder lacks, by name', undefined, undefined, { kind: 'notFound', program: game }, { kind: 'notFound', program: extenderLoader }],
    ['a program with no version resource, and a file that is no program, by name', windowsProgram(), Buffer.from('not a program'),
      { kind: 'noVersionResource', program: game }, { kind: 'notAProgram', program: extenderLoader }],
  ])('reads %s', async (_, gameProgram, loader, gameVersion, extenderVersion) => {
    await install(game, gameProgram);
    await install(extenderLoader, loader);

    expect(await programVersions({ kind: 'found', root, dataFolder: join(root, 'Data') }, RELEASE)).toEqual({ kind: 'found', game: gameVersion, extender: extenderVersion });
  });

  it('says why the file system would not read a program, naming it', async () => {
    await install(game, 'a folder');

    const versions = await programVersions({ kind: 'found', root, dataFolder: join(root, 'Data') }, RELEASE);

    expect(versions).toMatchObject({ kind: 'found', game: { kind: 'unreadable', program: game, why: expect.stringContaining('EISDIR') as unknown } });
  });

  it.each<[string, GameFolder | undefined, string | undefined]>([
    ['unresolved', NOT_FOUND, RELEASE],
    ['unknownGame', undefined, 'NoSuchRelease'],
    ['unknownGame', undefined, undefined],
  ])('reads neither version, %s, for game folder %j of release %s', async (kind, gameFolder, release) => {
    expect(await programVersions(gameFolder ?? { kind: 'found', root, dataFolder: join(root, 'Data') }, release)).toEqual({ kind });
  });
});
