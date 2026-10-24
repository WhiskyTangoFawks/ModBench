import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileVersionOf, productVersionOf } from '../versionResource';
import { windowsProgram } from '../../../test/windowsProgram';

describe('a program\'s version resource, as Windows reads it', () => {
  let folder: string;
  let program: string;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'version-resource-'));
    program = join(folder, 'Game.exe');
  });
  afterEach(() => rm(folder, { recursive: true, force: true }));

  it.each([
    [[1, 10, 163, 0], '1.10.163.0'],
    [[65535, 65534, 40000, 1], '65535.65534.40000.1'],
  ])('reads the file version %j as its four numbers', async (fileVersion, version) => {
    await writeFile(program, windowsProgram({ fileVersion }));

    expect(await fileVersionOf(program)).toBe(version);
  });

  it('reads the product version of the program\'s first translation', async () => {
    await writeFile(program, windowsProgram({ fileVersion: [1, 0, 0, 0], productVersion: '1.7.23.0' }));

    expect(await productVersionOf(program)).toBe('1.7.23.0');
  });

  it('reads no product version from a program whose version resource names none', async () => {
    await writeFile(program, windowsProgram({ fileVersion: [1, 0, 0, 0] }));

    expect(await productVersionOf(program)).toBe('');
  });

  it('refuses a program with no version resource, naming it', async () => {
    await writeFile(program, windowsProgram());

    await expect(fileVersionOf(program)).rejects.toThrow(`${program} has no version resource`);
  });

  it.each([
    ['a text file', Buffer.from('not a program')],
    ['a program cut short', windowsProgram({ fileVersion: [1, 0, 0, 0] }).subarray(0, 0x210)],
  ])('refuses %s as no Windows program, naming it', async (_, bytes) => {
    await writeFile(program, bytes);

    await expect(fileVersionOf(program)).rejects.toThrow(`${program} is not a Windows program`);
  });

  it('refuses a program that is not there with the file system\'s own code', async () => {
    await expect(fileVersionOf(program)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
