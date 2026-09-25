import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadPaths, spliceDownloadMeta, trashDownloadMeta } from '../downloadMeta';

describe('spliceDownloadMeta', () => {
  let downloadsDir: string;

  beforeEach(async () => {
    downloadsDir = await mkdtemp(join(tmpdir(), 'download-meta-'));
  });

  afterEach(async () => {
    await rm(downloadsDir, { recursive: true, force: true });
  });

  const metaPath = (name: string): string => join(downloadsDir, `${name}.meta`);

  it('hands the edit the file\'s text and writes back what it returns', async () => {
    await writeFile(metaPath('foo.7z'), '[General]\r\nmodID=123\r\n');

    expect(await spliceDownloadMeta(downloadsDir, 'foo.7z', (text) => `${text}removed=true\r\n`)).toEqual({ wrote: true });

    expect(await readFile(metaPath('foo.7z'), 'utf8')).toBe('[General]\r\nmodID=123\r\nremoved=true\r\n');
  });

  // MO2's QSettings creates the file on its first write, so a manual drop gets one too.
  it('hands the edit empty text for a file with no .meta, and writes one', async () => {
    const seen: string[] = [];

    await spliceDownloadMeta(downloadsDir, 'manual.7z', (text) => {
      seen.push(text);
      return '[General]\r\ninstalled=true\r\n';
    });

    expect(seen).toEqual(['']);
    expect(await readFile(metaPath('manual.7z'), 'utf8')).toBe('[General]\r\ninstalled=true\r\n');
  });

  // Doing nothing is not an error, and an unwritten file fires no watcher.
  it('writes nothing when the edit changes nothing', async () => {
    await writeFile(metaPath('foo.7z'), '[General]\r\ninstalled=true\r\n');
    const before = (await stat(metaPath('foo.7z'))).mtimeMs;

    expect(await spliceDownloadMeta(downloadsDir, 'foo.7z', (text) => text)).toEqual({ wrote: false });

    expect((await stat(metaPath('foo.7z'))).mtimeMs).toBe(before);
  });

  it('lets two edits of one .meta at once both land, each over the other\'s text', async () => {
    await writeFile(metaPath('foo.7z'), '[General]\r\n');

    await Promise.all([
      spliceDownloadMeta(downloadsDir, 'foo.7z', (text) => `${text}removed=true\r\n`),
      spliceDownloadMeta(downloadsDir, 'foo.7z', (text) => `${text}installed=true\r\n`),
    ]);

    const text = await readFile(metaPath('foo.7z'), 'utf8');
    expect(text).toContain('removed=true');
    expect(text).toContain('installed=true');
  });
});

describe('a downloaded file\'s two paths', () => {
  it('names the file and its .meta beside it', () => {
    expect(downloadPaths('/downloads', 'foo.7z')).toEqual({ path: join('/downloads', 'foo.7z'), sidecarPath: join('/downloads', 'foo.7z.meta') });
  });
});

describe('trashDownloadMeta', () => {
  let downloadsDir: string;

  beforeEach(async () => {
    downloadsDir = await mkdtemp(join(tmpdir(), 'download-meta-trash-'));
  });

  afterEach(async () => {
    await rm(downloadsDir, { recursive: true, force: true });
  });

  const trashed: string[] = [];
  const trash = (path: string): Promise<void> => { trashed.push(path); return rm(path); };

  it('moves the .meta to the trash, and answers that it did', async () => {
    trashed.length = 0;
    await writeFile(join(downloadsDir, 'foo.7z.meta'), '[General]\r\n');

    expect(await trashDownloadMeta(downloadsDir, 'foo.7z', trash)).toBe(true);

    expect(trashed).toEqual([join(downloadsDir, 'foo.7z.meta')]);
    await expect(access(join(downloadsDir, 'foo.7z.meta'))).rejects.toThrow();
  });

  it('trashes nothing for a file with no .meta', async () => {
    trashed.length = 0;

    expect(await trashDownloadMeta(downloadsDir, 'manual.7z', trash)).toBe(false);

    expect(trashed).toEqual([]);
  });
});
