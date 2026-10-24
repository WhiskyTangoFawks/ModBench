import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { programVersions } from '../programVersions';
import { programsOf } from '../../../tables/gamePaths';
import { present } from '../../../ports/present';
import { windowsProgram } from '../../../test/windowsProgram';
import type { GameFolder } from '../../instanceAdapter';

const RELEASE = 'Fallout4';
const { game, extenderLoader } = present(programsOf(RELEASE), 'the release\'s programs');
const NOT_FOUND: GameFolder = { kind: 'notFound', looked: [], setting: 'setting' };

describe('the versions of the game\'s and its script extender\'s programs, as MO2 reads them', () => {
  let root: string;
  let found: GameFolder;
  const install = (program: string, bytes: Buffer): Promise<void> => writeFile(join(root, program), bytes);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'program-versions-'));
    found = { kind: 'found', root, dataFolder: join(root, 'Data') };
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('reads the file version of the game\'s program and of the script extender\'s loader in the game folder', async () => {
    await install(game, windowsProgram({ fileVersion: [1, 10, 163, 0], productVersion: '9.9' }));
    await install(extenderLoader, windowsProgram({ fileVersion: [0, 0, 6, 23] }));

    expect(await programVersions(found, RELEASE)).toEqual({
      game: { kind: 'read', version: '1.10.163.0' },
      extender: { kind: 'read', version: '0.0.6.23' },
    });
  });

  it('reads the game\'s product version where its file version starts 1.0.0, and the extender\'s file version alone', async () => {
    await install(game, windowsProgram({ fileVersion: [1, 0, 0, 0], productVersion: '1.7.23.0' }));
    await install(extenderLoader, windowsProgram({ fileVersion: [1, 0, 0, 0], productVersion: '2.0' }));

    expect(await programVersions(found, RELEASE)).toEqual({
      game: { kind: 'read', version: '1.7.23.0' },
      extender: { kind: 'read', version: '1.0.0.0' },
    });
  });

  it('keeps the game\'s file version of 1.0.0 where it names no product version', async () => {
    await install(game, windowsProgram({ fileVersion: [1, 0, 0, 7] }));

    expect((await programVersions(found, RELEASE)).game).toEqual({ kind: 'read', version: '1.0.0.7' });
  });

  it('names each program the game folder does not hold', async () => {
    expect(await programVersions(found, RELEASE)).toEqual({
      game: { kind: 'notFound', program: game },
      extender: { kind: 'notFound', program: extenderLoader },
    });
  });

  it('says why a program\'s version cannot be read', async () => {
    await install(game, Buffer.from('not a program'));

    expect((await programVersions(found, RELEASE)).game).toEqual({ kind: 'unreadable', why: `${join(root, game)} is not a Windows program` });
  });

  it.each([
    ['the game folder was not found', NOT_FOUND, RELEASE],
    ['Modbench knows no program of this game', undefined, 'NoSuchRelease'],
    ['Modbench knows no program of this game', undefined, undefined],
  ])('reads neither version, saying %s', async (why, gameFolder, release) => {
    const unreadable = { kind: 'unreadable', why };

    expect(await programVersions(gameFolder ?? found, release)).toEqual({ game: unreadable, extender: unreadable });
  });
});
