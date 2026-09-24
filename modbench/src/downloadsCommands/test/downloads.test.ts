import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deleteDownloads, excludeDownload, excludeDownloads, includeDownload, includeDownloads,
  type DownloadsCommandResult,
} from '../downloads';
import { markDownloadInstalled } from '../../install/installedMark';
import { parseDownloadMeta } from '../../mo2Codecs/downloads';
import { assertSelectionOutcome } from '../../test/surfacingDoubles';

// expect.stringContaining's type is `any`, so this checks the refusal by hand instead of
// embedding the matcher in a toEqual object.
function assertRefusal(result: DownloadsCommandResult, expectedSubstring: string): void {
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

describe('excludeDownload / includeDownload', () => {
  it('exclude sets the sidecar flag MO2 reads as hidden, leaving its other keys alone', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    await writeSidecar(root, 'foo.7z', '[General]\r\nmodID=123\r\nversion=1.2\r\n');

    expect(await excludeDownload(root, 'foo.7z')).toEqual({ applied: true });

    expect(await sidecarOf(root, 'foo.7z')).toMatchObject({ hidden: true, modID: '123', version: '1.2' });
    expect(await readFile(sidecarPath(root, 'foo.7z'), 'utf8')).toContain('removed=true');
  });

  it('include clears the flag rather than dropping the key, as MO2 does', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    await writeSidecar(root, 'foo.7z', '[General]\r\nremoved=true\r\n');

    expect(await includeDownload(root, 'foo.7z')).toEqual({ applied: true });

    expect(await sidecarOf(root, 'foo.7z')).toMatchObject({ hidden: false });
    expect(await readFile(sidecarPath(root, 'foo.7z'), 'utf8')).toContain('removed=false');
  });

  it('excluding a metaless archive writes it a minimal sidecar, as MO2’s own auto-create does', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'manual.7z');

    expect(await excludeDownload(root, 'manual.7z')).toEqual({ applied: true });

    expect(await sidecarOf(root, 'manual.7z')).toMatchObject({ hidden: true });
  });

  it('excluding an already excluded download is applied, not a refusal', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    await writeSidecar(root, 'foo.7z', '[General]\r\nremoved=true\r\n');

    expect(await excludeDownload(root, 'foo.7z')).toEqual({ applied: true });
    expect(await sidecarOf(root, 'foo.7z')).toMatchObject({ hidden: true });
  });

  it('including a metaless archive writes it no sidecar — visible is already its default', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'manual.7z');

    expect(await includeDownload(root, 'manual.7z')).toEqual({ applied: true });

    await expect(readFile(sidecarPath(root, 'manual.7z'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // Rival: a splice that always writes. A locked sidecar makes any write attempt fail, so passing
  // here proves "no write attempted", not just "same bytes after".
  it('excluding an already excluded download writes nothing — a locked sidecar still applies', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const sidecar = await writeSidecar(root, 'foo.7z', '[General]\r\nremoved=true\r\n');
    await chmod(sidecar, 0o444);

    try {
      expect(await excludeDownload(root, 'foo.7z')).toEqual({ applied: true });
    } finally {
      await chmod(sidecar, 0o644);
    }
  });

  it('including an already included download writes nothing — a locked sidecar still applies', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const sidecar = await writeSidecar(root, 'foo.7z', '[General]\r\nremoved=false\r\n');
    await chmod(sidecar, 0o444);

    try {
      expect(await includeDownload(root, 'foo.7z')).toEqual({ applied: true });
    } finally {
      await chmod(sidecar, 0o644);
    }
  });

  // Confirms the two locked-sidecar tests above actually exercise a write path: the same lock,
  // but a real change (not already excluded), refuses instead of silently passing.
  it('excluding a visible download against a locked sidecar refuses, proving the lock bites', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const sidecar = await writeSidecar(root, 'foo.7z', '[General]\r\n');
    await chmod(sidecar, 0o444);

    try {
      const outcome = await excludeDownload(root, 'foo.7z');
      expect(outcome.applied).toBe(false);
    } finally {
      await chmod(sidecar, 0o644);
    }
  });

  it('excluding a file gone from disk is refused, naming it, and touches no sidecar', async () => {
    const root = await makeInstanceRoot();
    // No writeArchive: the row is stale — the archive vanished after the tree last read it.

    const outcome = await excludeDownload(root, 'foo.7z');

    assertRefusal(outcome, 'foo.7z');
    await expect(readFile(sidecarPath(root, 'foo.7z'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('including a file gone from disk is refused, naming it, and leaves its stale sidecar alone', async () => {
    const root = await makeInstanceRoot();
    // A lone `.meta` with no archive is exactly what a stale row must never widen.
    await writeSidecar(root, 'foo.7z', '[General]\r\nremoved=true\r\n');

    const outcome = await includeDownload(root, 'foo.7z');

    assertRefusal(outcome, 'foo.7z');
    expect(await sidecarOf(root, 'foo.7z')).toMatchObject({ hidden: true });
  });

  it('refuses, never throws, when the sidecar cannot be written', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    // A directory where the sidecar belongs: the write fails for a reason no caller can foresee.
    await mkdir(sidecarPath(root, 'foo.7z'));

    const outcome = await excludeDownload(root, 'foo.7z');

    expect(outcome.applied).toBe(false);
    expect(outcome).toHaveProperty('refusal', expect.stringContaining('EISDIR'));
  });
});

describe('excludeDownload beside install', () => {
  // Two verbs read-modify-write the same sidecar; interleaved, the second would splice the text
  // the first read, dropping the first key.
  it('an exclude racing install’s installed mark leaves both keys set', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    await writeSidecar(root, 'foo.7z', '[General]\r\n');

    await Promise.all([excludeDownload(root, 'foo.7z'), markDownloadInstalled(root, 'foo.7z')]);

    expect(await sidecarOf(root, 'foo.7z')).toMatchObject({ hidden: true, status: 'Installed' });
  });
});

describe('excludeDownloads / includeDownloads — over a selection', () => {
  it('excludes every landing name and refuses the one gone from disk, by name', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'a.7z');
    await writeArchive(root, 'b.7z');
    // 'gone.7z' has no archive: a stale row in the selection.

    const outcome = await excludeDownloads(root, ['a.7z', 'gone.7z', 'b.7z']);

    assertSelectionOutcome(outcome, {
      landed: ['a.7z', 'b.7z'],
      refused: [{ item: 'gone.7z', reasonContains: 'gone.7z' }],
    });
    expect(await sidecarOf(root, 'a.7z')).toMatchObject({ hidden: true });
    expect(await sidecarOf(root, 'b.7z')).toMatchObject({ hidden: true });
  });

  it('includes every landing name and refuses the one gone from disk, by name', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'a.7z');
    await writeSidecar(root, 'a.7z', '[General]\r\nremoved=true\r\n');
    await writeArchive(root, 'b.7z');
    await writeSidecar(root, 'b.7z', '[General]\r\nremoved=true\r\n');

    const outcome = await includeDownloads(root, ['a.7z', 'gone.7z', 'b.7z']);

    assertSelectionOutcome(outcome, {
      landed: ['a.7z', 'b.7z'],
      refused: [{ item: 'gone.7z', reasonContains: 'gone.7z' }],
    });
    expect(await sidecarOf(root, 'a.7z')).toMatchObject({ hidden: false });
    expect(await sidecarOf(root, 'b.7z')).toMatchObject({ hidden: false });
  });
});

describe('deleteDownloads', () => {
  it('trashes the sidecar BEFORE the archive: a mid-failure leaves a metaless archive, never a lone sidecar', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    const sidecar = await writeSidecar(root, 'foo.7z', '[General]\r\n');
    const trashed: string[] = [];

    const outcome = await deleteDownloads(root, ['foo.7z'], (path) => {
      trashed.push(path);
      return Promise.resolve();
    });

    expect(outcome).toEqual({ landed: ['foo.7z'], refused: [] });
    expect(trashed).toEqual([sidecar, archive]);
  });

  it('trashes only the archive when the download has no sidecar', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'manual.7z');
    const trashed: string[] = [];

    const outcome = await deleteDownloads(root, ['manual.7z'], (path) => {
      trashed.push(path);
      return Promise.resolve();
    });

    expect(outcome).toEqual({ landed: ['manual.7z'], refused: [] });
    expect(trashed).toEqual([archive]);
  });

  it('refuses with the trash’s own reason when it fails', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');

    expect(await deleteDownloads(root, ['foo.7z'], () => Promise.reject(new Error('EPERM')))).toEqual({
      landed: [],
      refused: [{ item: 'foo.7z', reason: 'EPERM' }],
    });
  });
});
