import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { downloadsDirectoryResolver } from '../downloadsDirectory';
import { NO_DETECTORS } from '../../../test/noDetectors';
import type { GameDetectors } from '../../gameFolder/gameFolderResolver';

const iniOf = (downloadDirectory?: string): string =>
  `[General]\r\ngameName=Fallout 4\r\n[Settings]\r\n${
    downloadDirectory === undefined ? '' : `download_directory=@ByteArray(${downloadDirectory.replaceAll('\\', '\\\\')})\r\n`}`;

const resolved = (downloadsDir: string) => ({ kind: 'resolved', downloadsDir });

describe('the downloads directory resolver', () => {
  const INSTANCE_ROOT = join('/instances', 'My Instance');
  const OUTSIDE = join('/mnt', 'storage', 'downloads');

  it.each([
    ['defaults to downloads/ under the instance root when the setting is absent', undefined, join(INSTANCE_ROOT, 'downloads')],
    ['resolves %BASE_DIR% to the instance root', '%BASE_DIR%/MyDownloads', join(INSTANCE_ROOT, 'MyDownloads')],
    ['takes an absolute path outright, even when it lies outside the instance', OUTSIDE, OUTSIDE],
    ['resolves a relative path against the instance root, Modbench\'s own choice as MO2 resolves it against its own process working directory (settings.cpp:1667-1686), not determinable from the instance alone',
      'MyDownloads', join(INSTANCE_ROOT, 'MyDownloads')],
  ])('%s', async (_, downloadDirectory, downloadsDir) => {
    expect(await downloadsDirectoryResolver(NO_DETECTORS)(INSTANCE_ROOT, iniOf(downloadDirectory))).toEqual(resolved(downloadsDir));
  });

  it.skipIf(process.platform === 'win32')('(Wine translates a drive letter only on Linux) normalizes a Z:-drive absolute path, as MO2 under Proton writes it, to its POSIX path', async () => {
    const real = join('/home', 'user', 'MyDownloads');
    const winePath = 'Z:' + real.replaceAll('/', '\\');

    expect(await downloadsDirectoryResolver(NO_DETECTORS)(INSTANCE_ROOT, iniOf(winePath))).toEqual(resolved(real));
  });

  it.skipIf(process.platform === 'win32')("(Wine translates a drive letter only on Linux) normalizes a C:-drive absolute path into the Proton prefix's drive_c, sharing gamePath's own Wine translation", async () => {
    const prefix = join('/home', 'user', '.steam', 'compatdata', '377160', 'pfx');
    const detectors: GameDetectors = { ...NO_DETECTORS, winePrefix: () => Promise.resolve(prefix) };

    expect(await downloadsDirectoryResolver(detectors)(INSTANCE_ROOT, iniOf('C:\\Games\\MO2\\downloads')))
      .toEqual(resolved(join(prefix, 'drive_c', 'Games/MO2/downloads')));
  });

  describe.skipIf(process.platform === 'win32')('(Wine translates a drive letter only on Linux) an untranslatable download_directory answers unresolved with why rather than guessing at the default folder, which is not the folder MO2 names', () => {
    it.each([
      ['naming the key and the drive, for a drive letter neither Z nor C', 'D:\\Games\\downloads', /download_directory.*drive/i],
      ['naming the prefix, for a C: path with no determinable Proton prefix', 'C:\\Games\\downloads', /download_directory.*prefix/i],
    ])('answers unresolved, %s', async (_, downloadDirectory, reason) => {
      expect(await downloadsDirectoryResolver(NO_DETECTORS)(INSTANCE_ROOT, iniOf(downloadDirectory)))
        .toEqual({ kind: 'unresolved', reason: expect.stringMatching(reason) as unknown });
    });
  });
});
