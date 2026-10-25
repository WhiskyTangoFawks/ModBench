import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spliceDownloadedFileMeta } from '../downloadedFileMeta';

describe('an edit of a downloaded file\'s .meta', () => {
  let downloadsDir: string;

  beforeEach(async () => {
    downloadsDir = await mkdtemp(join(tmpdir(), 'downloaded-file-meta-'));
  });

  afterEach(async () => {
    await rm(downloadsDir, { recursive: true, force: true });
  });

  const metaPath = (name: string): string => join(downloadsDir, `${name}.meta`);

  it('hands the edit the file\'s text and writes back what it returns', async () => {
    await writeFile(metaPath('foo.7z'), '[General]\r\nmodID=123\r\n');

    expect(await spliceDownloadedFileMeta(downloadsDir, 'foo.7z', (text) => `${text}removed=true\r\n`)).toEqual({ wrote: true });

    expect(await readFile(metaPath('foo.7z'), 'utf8')).toBe('[General]\r\nmodID=123\r\nremoved=true\r\n');
  });

  it('writes nothing when the edit changes nothing, doing nothing not being an error and an unwritten file firing no watcher', async () => {
    await writeFile(metaPath('foo.7z'), '[General]\r\ninstalled=true\r\n');
    const before = (await stat(metaPath('foo.7z'))).mtimeMs;

    expect(await spliceDownloadedFileMeta(downloadsDir, 'foo.7z', (text) => text)).toEqual({ wrote: false });

    expect((await stat(metaPath('foo.7z'))).mtimeMs).toBe(before);
  });

  it('lets two edits of one .meta at once both land, each over the other\'s text', async () => {
    await writeFile(metaPath('foo.7z'), '[General]\r\n');

    await Promise.all([
      spliceDownloadedFileMeta(downloadsDir, 'foo.7z', (text) => `${text}removed=true\r\n`),
      spliceDownloadedFileMeta(downloadsDir, 'foo.7z', (text) => `${text}installed=true\r\n`),
    ]);

    const text = await readFile(metaPath('foo.7z'), 'utf8');
    expect(text).toContain('removed=true');
    expect(text).toContain('installed=true');
  });
});
