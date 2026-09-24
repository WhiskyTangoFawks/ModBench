import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markDownloadInstalled } from '../installedMark';
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
  const root = await mkdtemp(join(tmpdir(), 'installed-mark-'));
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
});
