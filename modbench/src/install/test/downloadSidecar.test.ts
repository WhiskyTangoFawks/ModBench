import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deleteDownload,
  hideDownload,
  markDownloadInstalled,
  unhideDownload,
} from '../downloadSidecar';
import { parseDownloadMeta } from '../../mo2Codecs/downloads';

// expect.stringContaining's type is `any`, so this narrows the refusal branch by hand instead.
function assertRefusal(result: { applied: boolean; refusal?: string }, expectedSubstring: string): void {
  if (result.applied) throw new Error('expected a refusal, got applied:true');
  expect(result.refusal).toContain(expectedSubstring);
}

// tmpdirs made this test, removed in afterEach even when an assertion above the cleanup failed.
let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

async function makeInstanceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'downloads-commands-'));
  await mkdir(join(root, 'downloads'), { recursive: true });
  roots.push(root);
  return root;
}

const sidecarPath = (root: string, name: string): string => join(root, 'downloads', `${name}.meta`);

async function writeArchive(root: string, name: string): Promise<string> {
  const path = join(root, 'downloads', name);
  await writeFile(path, 'archive bytes');
  return path;
}

async function writeSidecar(root: string, name: string, text: string): Promise<string> {
  const path = sidecarPath(root, name);
  await writeFile(path, text);
  return path;
}

const sidecarOf = async (root: string, name: string) =>
  parseDownloadMeta(await readFile(sidecarPath(root, name), 'utf8'));

describe('hideDownload / unhideDownload', () => {
  it('hide sets the sidecar flag MO2 reads as hidden, leaving its other keys alone', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    await writeSidecar(root, 'foo.7z', '[General]\r\nmodID=123\r\nversion=1.2\r\n');

    expect(await hideDownload(root, 'foo.7z')).toEqual({ applied: true });

    expect(await sidecarOf(root, 'foo.7z')).toMatchObject({ hidden: true, modID: '123', version: '1.2' });
    expect(await readFile(sidecarPath(root, 'foo.7z'), 'utf8')).toContain('removed=true');
  });

  it('unhide clears the flag rather than dropping the key, as MO2 does', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    await writeSidecar(root, 'foo.7z', '[General]\r\nremoved=true\r\n');

    expect(await unhideDownload(root, 'foo.7z')).toEqual({ applied: true });

    expect(await sidecarOf(root, 'foo.7z')).toMatchObject({ hidden: false });
    expect(await readFile(sidecarPath(root, 'foo.7z'), 'utf8')).toContain('removed=false');
  });

  it('hiding a metaless archive writes it a minimal sidecar, as MO2’s own auto-create does', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'manual.7z');

    expect(await hideDownload(root, 'manual.7z')).toEqual({ applied: true });

    expect(await sidecarOf(root, 'manual.7z')).toMatchObject({ hidden: true });
  });

  it('hiding an already hidden download is applied, not a refusal', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    await writeSidecar(root, 'foo.7z', '[General]\r\nremoved=true\r\n');

    expect(await hideDownload(root, 'foo.7z')).toEqual({ applied: true });
    expect(await sidecarOf(root, 'foo.7z')).toMatchObject({ hidden: true });
  });

  it('refuses, never throws, when the sidecar cannot be written', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    // A directory where the sidecar belongs: the write fails for a reason no caller can foresee.
    await mkdir(sidecarPath(root, 'foo.7z'));

    const outcome = await hideDownload(root, 'foo.7z');

    expect(outcome.applied).toBe(false);
    expect(outcome).toHaveProperty('refusal', expect.stringContaining('EISDIR'));
  });
});

describe('markDownloadInstalled', () => {
  it('sets the sidecar flag MO2’s Downloads tab reads as installed', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    await writeSidecar(root, 'foo.7z', '[General]\r\nmodID=123\r\n');

    expect(await markDownloadInstalled(root, 'foo.7z')).toEqual({ applied: true });

    expect(await sidecarOf(root, 'foo.7z')).toMatchObject({ status: 'Installed', modID: '123' });
    const text = await readFile(sidecarPath(root, 'foo.7z'), 'utf8');
    expect(text).toContain('installed=true');
    // MO2's markInstalled writes both keys, and its tab reads `uninstalled` first.
    expect(text).toContain('uninstalled=false');
  });

  it('writes a sidecar for an archive that had none, so the status survives the install', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'manual.7z');

    expect(await markDownloadInstalled(root, 'manual.7z')).toEqual({ applied: true });

    expect(await sidecarOf(root, 'manual.7z')).toMatchObject({ status: 'Installed' });
  });

  it('refuses, never throws, when the sidecar cannot be written', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    await mkdir(sidecarPath(root, 'foo.7z'));

    assertRefusal(await markDownloadInstalled(root, 'foo.7z'), 'EISDIR');
  });

  // Two verbs read-modify-write the same sidecar; interleaved, the second would splice the text
  // the first read, dropping the first key.
  it('a hide racing a mark installed leaves both keys set', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    await writeSidecar(root, 'foo.7z', '[General]\r\n');

    await Promise.all([hideDownload(root, 'foo.7z'), markDownloadInstalled(root, 'foo.7z')]);

    expect(await sidecarOf(root, 'foo.7z')).toMatchObject({ hidden: true, status: 'Installed' });
  });
});

describe('deleteDownload', () => {
  it('trashes the sidecar BEFORE the archive: a mid-failure leaves a metaless archive, never a lone sidecar', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    const sidecar = await writeSidecar(root, 'foo.7z', '[General]\r\n');
    const trashed: string[] = [];

    const outcome = await deleteDownload(root, 'foo.7z', (path) => {
      trashed.push(path);
      return Promise.resolve();
    });

    expect(outcome).toEqual({ applied: true });
    expect(trashed).toEqual([sidecar, archive]);
  });

  it('trashes only the archive when the download has no sidecar', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'manual.7z');
    const trashed: string[] = [];

    const outcome = await deleteDownload(root, 'manual.7z', (path) => {
      trashed.push(path);
      return Promise.resolve();
    });

    expect(outcome).toEqual({ applied: true });
    expect(trashed).toEqual([archive]);
  });

  it('refuses with the trash’s own reason when it fails', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');

    expect(await deleteDownload(root, 'foo.7z', () => Promise.reject(new Error('EPERM')))).toEqual({
      applied: false,
      refusal: 'EPERM',
    });
  });
});
