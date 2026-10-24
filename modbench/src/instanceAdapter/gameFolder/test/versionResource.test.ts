import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { versionResourceOf } from '../versionResource';
import { versionInfo, windowsProgram } from '../../../test/windowsProgram';

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

describe('a program\'s version resource, as Windows reads it', () => {
  let folder: string;
  let program: string;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'version-resource-'));
    program = join(folder, 'Game.exe');
  });
  afterEach(() => rm(folder, { recursive: true, force: true }));

  it.each([
    ['a PE32+ program', windowsProgram({ version: versionInfo([1, 10, 163, 0], '1.7.23.0') }), '1.10.163.0', '1.7.23.0'],
    ['a PE32 program', windowsProgram({ format: 'PE32', version: versionInfo([65535, 65534, 40000, 1], '2.0') }), '65535.65534.40000.1', '2.0'],
    ['a program that names no product version', windowsProgram({ version: versionInfo([1, 0, 0, 0]) }), '1.0.0.0', ''],
    ['a program whose headers claim 4 GiB of resources', windowsProgram({ version: versionInfo([1, 2, 3, 4]), claimedSize: 0xfffffff0 }), '1.2.3.4', ''],
    ['a resource whose blocks overlap', windowsProgram({ version: versionInfo([1, 2, 3, 4], undefined, [blocksEachOverlappingTheNextTwo(600)]) }), '1.2.3.4', ''],
    ['a block read no further than the block that holds it', windowsProgram({ version: stringTableEndingTwoCharactersIntoItsProductVersion() }), '1.0.0.0', '1.'],
  ])('reads the file version as its four numbers, and the first translation\'s product version, of %s', async (_, bytes, fileVersion, productVersion) => {
    await writeFile(program, bytes);

    expect(await versionResourceOf(program)).toEqual({ kind: 'read', fileVersion, productVersion });
  });

  it.each([
    ['noVersionResource', 'a program with no version resource', windowsProgram()],
    ['notAProgram', 'a text file', Buffer.from('not a program')],
    ['notAProgram', 'a program cut short', windowsProgram({ version: versionInfo([1, 0, 0, 0]) }).subarray(0, 0x210)],
  ])('answers %s for %s', async (kind, _, bytes) => {
    await writeFile(program, bytes);

    expect(await versionResourceOf(program)).toEqual({ kind });
  });

  it('rejects a program that is not there with the file system\'s own code', async () => {
    await expect(versionResourceOf(program)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
