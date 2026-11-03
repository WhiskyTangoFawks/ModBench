import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crc32 } from 'node:zlib';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataFileReads, type DataFileReads } from '../dataFileReads';
import { versionInfo, windowsProgram } from '../../../test/windowsProgram';
import type { GameFolder } from '../../instanceAdapter';

describe('dataFileReads: what LOOT\'s conditions read of a file', () => {
  let root: string;
  let reads: DataFileReads;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'data-file-reads-'));
    await mkdir(join(root, 'Data'));
    const found: GameFolder = { kind: 'found', root, dataFolder: join(root, 'Data') };
    reads = dataFileReads(async () => found);
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('checksums a file in the Data folder as CRC-32 of its bytes, and a path that leaves it', async () => {
    await writeFile(join(root, 'Data', 'a.swf'), 'some bytes');
    await writeFile(join(root, 'Game.exe'), 'game bytes');

    expect([await reads.dataFileChecksum('a.swf', undefined), await reads.dataFileChecksum('../Game.exe', undefined)])
      .toEqual([crc32('some bytes'), crc32('game bytes')]);
  });

  it('checksums the file mod order provides, not the Data folder\'s', async () => {
    await writeFile(join(root, 'Data', 'a.swf'), 'game');
    await writeFile(join(root, 'mod.swf'), 'mod');

    expect(await reads.dataFileChecksum('a.swf', join(root, 'mod.swf'))).toBe(crc32('mod'));
  });

  it('answers no checksum, no version and not readable for a file that is not there', async () => {
    expect([
      await reads.dataFileChecksum('gone.swf', undefined),
      await reads.dataFileVersion('../Gone.exe', undefined, 'file'),
      await reads.dataFileReadable('../Gone.exe', undefined),
    ]).toEqual([undefined, undefined, false]);
  });

  it('reads the file or product version of a program, and none for a program without one', async () => {
    await writeFile(join(root, 'Game.exe'), windowsProgram({ version: versionInfo([1, 10, 163, 0], '1.10') }));
    await writeFile(join(root, 'Bare.exe'), windowsProgram());

    expect([
      await reads.dataFileVersion('../Game.exe', undefined, 'file'),
      await reads.dataFileVersion('../Game.exe', undefined, 'product'),
      await reads.dataFileVersion('../Bare.exe', undefined, 'file'),
    ]).toEqual(['1.10.163.0', '1.10', undefined]);
  });

  it('rejects, saying why, for a version of a file that is no program', async () => {
    await writeFile(join(root, 'Data', 'a.swf'), 'not a program');

    await expect(reads.dataFileVersion('a.swf', undefined, 'file')).rejects.toThrow('a.swf is not a Windows program');
  });

  it('reads a file as readable, and a folder too', async () => {
    await writeFile(join(root, 'Game.exe'), 'x');

    expect([await reads.dataFileReadable('../Game.exe', undefined), await reads.dataFileReadable('.', undefined)]).toEqual([true, true]);
  });

  it('rejects, saying why, for a file of a game folder that was not found', async () => {
    const lost = dataFileReads(async () => ({ kind: 'notFound', looked: [], setting: 's' }));

    await expect(lost.dataFileChecksum('a.swf', undefined)).rejects.toThrow('the game folder was not found');
    await expect(lost.dataFileChecksum('a.swf', '/mod/a.swf')).resolves.toBeUndefined();
  });
});
