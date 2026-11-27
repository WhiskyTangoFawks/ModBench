import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { InstanceAdapter } from '../../instanceAdapter';
import { versionInfo, windowsProgram } from '../../../test/windowsProgram';
import { fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';
import { adapterOver } from '../../../test/mo2/adapterOver';
import { gameOnDisk, instanceOnDisk } from '../../test/instanceOnDisk';

vi.mock('vscode', () => fakeVscodeModule());

function blocksEachOverlappingTheNextTwo(count: number): Buffer {
  const bytes = Buffer.alloc(count * 8 + 64);
  for (let k = 0; k < count; k++) bytes.writeUInt16LE([40, 16, 24][k % 3] ?? 0, k * 8);
  return bytes;
}

function stringTableEndingTwoCharactersIntoItsProductVersion(): Buffer {
  const info = versionInfo([1, 0, 0, 0], '1.7.23.0');
  const table = info.indexOf(Buffer.from('040904B0', 'utf16le')) - 6;
  info.writeUInt16LE(info.indexOf(Buffer.from('1.7.23.0', 'utf16le')) + 4 - table, table);
  return info;
}

describe('a program\'s version resource, as Windows reads it, for the versions LOOT\'s conditions read', () => {
  let game: string;
  let instance: string;
  let adapter: InstanceAdapter;

  beforeEach(async () => {
    game = await gameOnDisk();
    instance = await instanceOnDisk();
    adapter = adapterOver(instance, { gameFolderSettingValue: game });
  });
  afterEach(async () => {
    await rm(game, { recursive: true, force: true });
    await rm(instance, { recursive: true, force: true });
  });

  const versionsOfProgram = async (bytes: Buffer): Promise<unknown[]> => {
    await writeFile(join(game, 'Game.exe'), bytes);
    return [await adapter.dataFileVersion('../Game.exe', undefined, 'file'), await adapter.dataFileVersion('../Game.exe', undefined, 'product')];
  };
  const read = (value: string | undefined) => ({ kind: 'read', value });

  it.each([
    ['a PE32+ program', windowsProgram({ version: versionInfo([1, 10, 163, 0], '1.7.23.0') }), '1.10.163.0', '1.7.23.0'],
    ['a PE32 program', windowsProgram({ format: 'PE32', version: versionInfo([65535, 65534, 40000, 1], '2.0') }), '65535.65534.40000.1', '2.0'],
    ['a program that names no product version', windowsProgram({ version: versionInfo([1, 0, 0, 0]) }), '1.0.0.0', undefined],
    ['a program whose headers claim 4 GiB of resources', windowsProgram({ version: versionInfo([1, 2, 3, 4]), claimedSize: 0xfffffff0 }), '1.2.3.4', undefined],
    ['a resource whose blocks overlap', windowsProgram({ version: versionInfo([1, 2, 3, 4], undefined, [blocksEachOverlappingTheNextTwo(600)]) }), '1.2.3.4', undefined],
    ['a block read no further than the block that holds it', windowsProgram({ version: stringTableEndingTwoCharactersIntoItsProductVersion() }), '1.0.0.0', '1.'],
  ])('reads the file version as its four numbers, and the first translation\'s product version, of %s', async (_, bytes, fileVersion, productVersion) => {
    expect(await versionsOfProgram(bytes)).toEqual([read(fileVersion), read(productVersion)]);
  });

  it('reads no version of a program with no version resource', async () => {
    expect(await versionsOfProgram(windowsProgram())).toEqual([read(undefined), read(undefined)]);
  });

  it.each([
    ['a text file', Buffer.from('not a program')],
    ['a program cut short', windowsProgram({ version: versionInfo([1, 0, 0, 0]) }).subarray(0, 0x210)],
  ])('answers why for %s, which is no program', async (_, bytes) => {
    const why = { kind: 'unreadable', why: '../Game.exe is not a Windows program' };

    expect(await versionsOfProgram(bytes)).toEqual([why, why]);
  });
});
