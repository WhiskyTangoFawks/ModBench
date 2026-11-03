import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crc32 } from 'node:zlib';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataFileReads, type DataFileReads } from '../dataFileReads';
import { versionInfo, windowsProgram } from '../../../test/windowsProgram';
import type { GameFolder } from '../../instanceAdapter';

const read = <T>(value: T) => ({ kind: 'read', value });

describe('dataFileReads: what LOOT\'s conditions read of a file', () => {
  let root: string;
  let reads: DataFileReads;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'data-file-reads-'));
    await mkdir(join(root, 'Data'));
    const found: GameFolder = { kind: 'found', root, dataFolder: join(root, 'Data') };
    reads = dataFileReads(() => Promise.resolve(found));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('checksums a file in the Data folder as CRC-32 of its bytes, and a path that leaves it', async () => {
    await writeFile(join(root, 'Data', 'a.swf'), 'some bytes');
    await writeFile(join(root, 'Game.exe'), 'game bytes');

    expect([await reads.dataFileChecksum('a.swf', undefined), await reads.dataFileChecksum('../Game.exe', undefined)])
      .toEqual([read(crc32('some bytes')), read(crc32('game bytes'))]);
  });

  it('finds the game folder\'s file in any case, in the folders and the name, as the game does', async () => {
    await mkdir(join(root, 'Data', 'Interface'));
    await writeFile(join(root, 'Data', 'Interface', 'DialogueMenu.swf'), 'bytes');
    await writeFile(join(root, 'Fallout4.exe'), 'game');

    expect([
      await reads.dataFileChecksum('interface/dialoguemenu.SWF', undefined),
      await reads.dataFileChecksum('../fallout4.EXE', undefined),
      await reads.dataFileReadable('INTERFACE', undefined),
    ]).toEqual([read(crc32('bytes')), read(crc32('game')), read(true)]);
  });

  it('checksums the file mod order provides, not the Data folder\'s', async () => {
    await writeFile(join(root, 'Data', 'a.swf'), 'game');
    await writeFile(join(root, 'mod.swf'), 'mod');

    expect(await reads.dataFileChecksum('a.swf', join(root, 'mod.swf'))).toEqual(read(crc32('mod')));
  });

  it('answers no checksum, no version and not readable for a file that is not there', async () => {
    expect([
      await reads.dataFileChecksum('gone.swf', undefined),
      await reads.dataFileVersion('../Gone.exe', undefined, 'file'),
      await reads.dataFileReadable('../Gone.exe', undefined),
    ]).toEqual([read(undefined), read(undefined), read(false)]);
  });

  it('reads the file or product version of a program, and none for a program without a version number', async () => {
    await writeFile(join(root, 'Game.exe'), windowsProgram({ version: versionInfo([1, 10, 163, 0], '1.10') }));
    await writeFile(join(root, 'NoProduct.exe'), windowsProgram({ version: versionInfo([1, 10, 163, 0]) }));
    await writeFile(join(root, 'Bare.exe'), windowsProgram());

    expect([
      await reads.dataFileVersion('../Game.exe', undefined, 'file'),
      await reads.dataFileVersion('../Game.exe', undefined, 'product'),
      await reads.dataFileVersion('../NoProduct.exe', undefined, 'product'),
      await reads.dataFileVersion('../Bare.exe', undefined, 'file'),
    ]).toEqual([read('1.10.163.0'), read('1.10'), read(undefined), read(undefined)]);
  });

  it('answers why for a version of a file that is no program', async () => {
    await writeFile(join(root, 'Data', 'a.swf'), 'not a program');

    expect(await reads.dataFileVersion('a.swf', undefined, 'file')).toEqual({ kind: 'unreadable', why: 'a.swf is not a Windows program' });
  });

  it('reads a file as readable, and a folder too', async () => {
    await writeFile(join(root, 'Game.exe'), 'x');

    expect([await reads.dataFileReadable('../Game.exe', undefined), await reads.dataFileReadable('.', undefined)]).toEqual([read(true), read(true)]);
  });

  it('answers why for a file of a game folder that was not found, and reads the winner all the same', async () => {
    const lost = dataFileReads(() => Promise.resolve<GameFolder>({ kind: 'notFound', looked: [], setting: 's' }));

    expect(await lost.dataFileChecksum('a.swf', undefined)).toEqual({ kind: 'unreadable', why: 'the game folder was not found' });
    expect(await lost.dataFileChecksum('a.swf', '/mod/a.swf')).toEqual(read(undefined));
  });
});
