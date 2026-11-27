import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { NO_DETECTORS } from '../../../test/noDetectors';
import { onPosix } from '../../../test/platform';
import { fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';
import { cloneCorpusFixture } from '../../../test/mo2/corpusFixture';

vi.mock('vscode', () => fakeVscodeModule());

import { adapterOver, type AdapterAnswers } from '../../../test/mo2/adapterOver';
import type { DownloadedFiles } from '../../instanceAdapter';
import { qSettingsPath } from '../../test/instanceOnDisk';

describe('the downloads directory resolver', () => {
  let root: string;
  beforeEach(() => {
    root = cloneCorpusFixture();
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const OUTSIDE = join('/mnt', 'storage', 'downloads');

  const downloadedFilesWith = async (downloadDirectory: string | undefined, answers: AdapterAnswers = {}): Promise<DownloadedFiles> => {
    if (downloadDirectory !== undefined) await appendFile(join(root, 'ModOrganizer.ini'), `download_directory=${qSettingsPath(downloadDirectory)}\r\n`);
    return (await adapterOver(root, answers).reading()).downloadedFiles;
  };
  const resolved = (downloadsDir: string) => expect.objectContaining({ kind: 'listed', downloadsDir }) as unknown;

  it.each([
    ['defaults to downloads/ under the instance root when the setting is absent', undefined, 'downloads'],
    ['resolves %BASE_DIR% to the instance root', '%BASE_DIR%/MyDownloads', 'MyDownloads'],
    ['resolves a relative path against the instance root, Modbench\'s own choice as MO2 resolves it against its own process working directory (settings.cpp:1667-1686), not determinable from the instance alone',
      'MyDownloads', 'MyDownloads'],
  ])('%s', async (_, downloadDirectory, below) => {
    expect(await downloadedFilesWith(downloadDirectory)).toEqual(resolved(join(root, below)));
  });

  it('takes an absolute path outright, even when it lies outside the instance', async () => {
    expect(await downloadedFilesWith(OUTSIDE)).toEqual(resolved(OUTSIDE));
  });

  onPosix.it('(Wine translates a drive letter only on Linux) normalizes a Z:-drive absolute path, as MO2 under Proton writes it, to its POSIX path', async () => {
    const real = join('/home', 'user', 'MyDownloads');
    const winePath = 'Z:' + real.replaceAll('/', '\\');

    expect(await downloadedFilesWith(winePath)).toEqual(resolved(real));
  });

  onPosix.it("(Wine translates a drive letter only on Linux) normalizes a C:-drive absolute path into the Proton prefix's drive_c, sharing gamePath's own Wine translation", async () => {
    const prefix = join('/home', 'user', '.steam', 'compatdata', '377160', 'pfx');

    expect(await downloadedFilesWith('C:\\Games\\MO2\\downloads', { detectors: { ...NO_DETECTORS, winePrefix: () => Promise.resolve(prefix) } }))
      .toEqual(resolved(join(prefix, 'drive_c', 'Games/MO2/downloads')));
  });

  onPosix.describe('(Wine translates a drive letter only on Linux) an untranslatable download_directory answers unresolved with why rather than guessing at the default folder, which is not the folder MO2 names', () => {
    it.each([
      ['naming the key and the drive, for a drive letter neither Z nor C', 'D:\\Games\\downloads', /download_directory.*drive/i],
      ['naming the prefix, for a C: path with no determinable Proton prefix', 'C:\\Games\\downloads', /download_directory.*prefix/i],
    ])('answers unresolved, %s', async (_, downloadDirectory, reason) => {
      expect(await downloadedFilesWith(downloadDirectory)).toEqual({ kind: 'unresolved', reason: expect.stringMatching(reason) as unknown });
    });
  });
});
