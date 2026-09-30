import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { markDownloadInstalled, type InstalledMarkResult } from '../installedMark';
import { cloneCorpusFixture } from '../../test/mo2/corpusFixture';
import { adapterOver, readDownloadedFileMeta } from '../../test/mo2/adapterOver';
import type { InstanceAdapter } from '../../instanceAdapter/instanceAdapter';

// expect.stringContaining's type is `any`, so this narrows the refusal branch by hand instead.
function assertRefusal(result: InstalledMarkResult, expectedSubstring: string): void {
  if (result.applied) throw new Error('expected a refusal, got applied:true');
  expect(result.refusal).toContain(expectedSubstring);
}

let root: string;
let adapter: InstanceAdapter;

beforeEach(async () => {
  root = await cloneCorpusFixture();
  adapter = adapterOver(root);
});
afterEach(() => rm(root, { recursive: true, force: true }));

const archivePath = (name: string): string => join(root, 'downloads', name);

const statusOf = async (name: string) => (await readDownloadedFileMeta(root, name))?.status;

describe('markDownloadInstalled', () => {
  it('marks a downloaded file installed, one with no metadata included', async () => {
    await writeFile(archivePath('manual.7z'), 'archive bytes');

    expect(await markDownloadInstalled(adapter, 'manual.7z')).toEqual({ applied: true });

    expect(await statusOf('manual.7z')).toBe('Installed');
  });

  // Rival: read `gone` as marked, so a file that left the disk reads as done.
  it('refuses, naming it, a downloaded file gone from disk, and writes it no metadata', async () => {
    assertRefusal(await markDownloadInstalled(adapter, 'gone.7z'), '"gone.7z" is gone from disk');

    await expect(readFile(`${archivePath('gone.7z')}.meta`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses, never throws, when the metadata cannot be written', async () => {
    await writeFile(archivePath('foo.7z'), 'archive bytes');
    await mkdir(`${archivePath('foo.7z')}.meta`);

    assertRefusal(await markDownloadInstalled(adapter, 'foo.7z'), 'EISDIR');
  });
});
