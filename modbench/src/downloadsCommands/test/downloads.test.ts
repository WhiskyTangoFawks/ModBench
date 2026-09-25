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
  await Promise.all(roots.map((downloadsDir) => rm(downloadsDir, { recursive: true, force: true })));
  roots = [];
});

// A bare downloads folder — never nested under an instance-shaped tree — so these tests prove
// the commands take the folder they are given, with no assumption about what contains it.
async function makeDownloadsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'downloads-commands-'));
  roots.push(dir);
  return dir;
}

const sidecarPath = (downloadsDir: string, name: string): string => join(downloadsDir, `${name}.meta`);

async function writeArchive(downloadsDir: string, name: string): Promise<string> {
  const path = join(downloadsDir, name);
  await writeFile(path, 'archive bytes');
  return path;
}

async function writeSidecar(downloadsDir: string, name: string, text: string): Promise<string> {
  const path = sidecarPath(downloadsDir, name);
  await writeFile(path, text);
  return path;
}

const sidecarOf = async (downloadsDir: string, name: string) =>
  parseDownloadMeta(await readFile(sidecarPath(downloadsDir, name), 'utf8'));

describe('excludeDownload / includeDownload', () => {
  it('exclude sets the sidecar flag MO2 reads as hidden, leaving its other keys alone', async () => {
    const downloadsDir = await makeDownloadsDir();
    await writeArchive(downloadsDir, 'foo.7z');
    await writeSidecar(downloadsDir, 'foo.7z', '[General]\r\nmodID=123\r\nversion=1.2\r\n');

    expect(await excludeDownload(downloadsDir, 'foo.7z')).toEqual({ applied: true, wrote: true });

    expect(await sidecarOf(downloadsDir, 'foo.7z')).toMatchObject({ excluded: true, modID: '123', version: '1.2' });
    expect(await readFile(sidecarPath(downloadsDir, 'foo.7z'), 'utf8')).toContain('removed=true');
  });

  it('include clears the flag rather than dropping the key, as MO2 does', async () => {
    const downloadsDir = await makeDownloadsDir();
    await writeArchive(downloadsDir, 'foo.7z');
    await writeSidecar(downloadsDir, 'foo.7z', '[General]\r\nremoved=true\r\n');

    expect(await includeDownload(downloadsDir, 'foo.7z')).toEqual({ applied: true, wrote: true });

    expect(await sidecarOf(downloadsDir, 'foo.7z')).toMatchObject({ excluded: false });
    expect(await readFile(sidecarPath(downloadsDir, 'foo.7z'), 'utf8')).toContain('removed=false');
  });

  it('excluding a metaless archive writes it a minimal sidecar, as MO2’s own auto-create does', async () => {
    const downloadsDir = await makeDownloadsDir();
    await writeArchive(downloadsDir, 'manual.7z');

    expect(await excludeDownload(downloadsDir, 'manual.7z')).toEqual({ applied: true, wrote: true });

    expect(await sidecarOf(downloadsDir, 'manual.7z')).toMatchObject({ excluded: true });
  });

  it('excluding an already excluded download is applied, not a refusal', async () => {
    const downloadsDir = await makeDownloadsDir();
    await writeArchive(downloadsDir, 'foo.7z');
    await writeSidecar(downloadsDir, 'foo.7z', '[General]\r\nremoved=true\r\n');

    expect(await excludeDownload(downloadsDir, 'foo.7z')).toEqual({ applied: true, wrote: false });
    expect(await sidecarOf(downloadsDir, 'foo.7z')).toMatchObject({ excluded: true });
  });

  it('including a metaless archive writes it no sidecar — visible is already its default', async () => {
    const downloadsDir = await makeDownloadsDir();
    await writeArchive(downloadsDir, 'manual.7z');

    expect(await includeDownload(downloadsDir, 'manual.7z')).toEqual({ applied: true, wrote: false });

    await expect(readFile(sidecarPath(downloadsDir, 'manual.7z'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // Rival: a splice that always writes. A locked sidecar makes any write attempt fail, so passing
  // here proves "no write attempted", not just "same bytes after".
  it('excluding an already excluded download writes nothing — a locked sidecar still applies', async () => {
    const downloadsDir = await makeDownloadsDir();
    await writeArchive(downloadsDir, 'foo.7z');
    const sidecar = await writeSidecar(downloadsDir, 'foo.7z', '[General]\r\nremoved=true\r\n');
    await chmod(sidecar, 0o444);

    try {
      expect(await excludeDownload(downloadsDir, 'foo.7z')).toEqual({ applied: true, wrote: false });
    } finally {
      await chmod(sidecar, 0o644);
    }
  });

  it('including an already included download writes nothing — a locked sidecar still applies', async () => {
    const downloadsDir = await makeDownloadsDir();
    await writeArchive(downloadsDir, 'foo.7z');
    const sidecar = await writeSidecar(downloadsDir, 'foo.7z', '[General]\r\nremoved=false\r\n');
    await chmod(sidecar, 0o444);

    try {
      expect(await includeDownload(downloadsDir, 'foo.7z')).toEqual({ applied: true, wrote: false });
    } finally {
      await chmod(sidecar, 0o644);
    }
  });

  // Confirms the two locked-sidecar tests above actually exercise a write path: the same lock,
  // but a real change (not already excluded), refuses instead of silently passing.
  it('excluding a visible download against a locked sidecar refuses, proving the lock bites', async () => {
    const downloadsDir = await makeDownloadsDir();
    await writeArchive(downloadsDir, 'foo.7z');
    const sidecar = await writeSidecar(downloadsDir, 'foo.7z', '[General]\r\n');
    await chmod(sidecar, 0o444);

    try {
      const outcome = await excludeDownload(downloadsDir, 'foo.7z');
      expect(outcome.applied).toBe(false);
    } finally {
      await chmod(sidecar, 0o644);
    }
  });

  it('excluding a file gone from disk is refused, naming it, and touches no sidecar', async () => {
    const downloadsDir = await makeDownloadsDir();
    // No writeArchive: the row is stale — the archive vanished after the tree last read it.

    const outcome = await excludeDownload(downloadsDir, 'foo.7z');

    assertRefusal(outcome, 'foo.7z');
    await expect(readFile(sidecarPath(downloadsDir, 'foo.7z'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('including a file gone from disk is refused, naming it, and leaves its stale sidecar alone', async () => {
    const downloadsDir = await makeDownloadsDir();
    // A lone `.meta` with no archive is exactly what a stale row must never widen.
    await writeSidecar(downloadsDir, 'foo.7z', '[General]\r\nremoved=true\r\n');

    const outcome = await includeDownload(downloadsDir, 'foo.7z');

    assertRefusal(outcome, 'foo.7z');
    expect(await sidecarOf(downloadsDir, 'foo.7z')).toMatchObject({ excluded: true });
  });

  it('refuses, never throws, when the sidecar cannot be written', async () => {
    const downloadsDir = await makeDownloadsDir();
    await writeArchive(downloadsDir, 'foo.7z');
    // A directory where the sidecar belongs: the write fails for a reason no caller can foresee.
    await mkdir(sidecarPath(downloadsDir, 'foo.7z'));

    const outcome = await excludeDownload(downloadsDir, 'foo.7z');

    expect(outcome.applied).toBe(false);
    expect(outcome).toHaveProperty('refusal', expect.stringContaining('EISDIR'));
  });
});

describe('excludeDownload beside install', () => {
  // Two verbs read-modify-write the same sidecar; interleaved, the second would splice the text
  // the first read, dropping the first key.
  it('an exclude racing install’s installed mark leaves both keys set', async () => {
    const downloadsDir = await makeDownloadsDir();
    await writeArchive(downloadsDir, 'foo.7z');
    await writeSidecar(downloadsDir, 'foo.7z', '[General]\r\n');

    await Promise.all([excludeDownload(downloadsDir, 'foo.7z'), markDownloadInstalled(downloadsDir, 'foo.7z')]);

    expect(await sidecarOf(downloadsDir, 'foo.7z')).toMatchObject({ excluded: true, status: 'Installed' });
  });
});

describe('excludeDownloads / includeDownloads — over a selection', () => {
  it('excludes every landing name and refuses the one gone from disk, by name', async () => {
    const downloadsDir = await makeDownloadsDir();
    await writeArchive(downloadsDir, 'a.7z');
    await writeArchive(downloadsDir, 'b.7z');
    // 'gone.7z' has no archive: a stale row in the selection.

    const outcome = await excludeDownloads(downloadsDir, ['a.7z', 'gone.7z', 'b.7z']);

    assertSelectionOutcome(outcome, {
      landed: ['a.7z', 'b.7z'],
      refused: [{ item: 'gone.7z', reasonContains: 'gone.7z' }],
    });
    expect(await sidecarOf(downloadsDir, 'a.7z')).toMatchObject({ excluded: true });
    expect(await sidecarOf(downloadsDir, 'b.7z')).toMatchObject({ excluded: true });
  });

  it('includes every landing name and refuses the one gone from disk, by name', async () => {
    const downloadsDir = await makeDownloadsDir();
    await writeArchive(downloadsDir, 'a.7z');
    await writeSidecar(downloadsDir, 'a.7z', '[General]\r\nremoved=true\r\n');
    await writeArchive(downloadsDir, 'b.7z');
    await writeSidecar(downloadsDir, 'b.7z', '[General]\r\nremoved=true\r\n');

    const outcome = await includeDownloads(downloadsDir, ['a.7z', 'gone.7z', 'b.7z']);

    assertSelectionOutcome(outcome, {
      landed: ['a.7z', 'b.7z'],
      refused: [{ item: 'gone.7z', reasonContains: 'gone.7z' }],
    });
    expect(await sidecarOf(downloadsDir, 'a.7z')).toMatchObject({ excluded: false });
    expect(await sidecarOf(downloadsDir, 'b.7z')).toMatchObject({ excluded: false });
  });
});

describe('deleteDownloads', () => {
  it('trashes the archive BEFORE its sidecar: a mid-failure leaves the sidecar in place, never a metaless trash', async () => {
    const downloadsDir = await makeDownloadsDir();
    const archive = await writeArchive(downloadsDir, 'foo.7z');
    const sidecar = await writeSidecar(downloadsDir, 'foo.7z', '[General]\r\n');
    const trashed: string[] = [];

    const outcome = await deleteDownloads(downloadsDir, ['foo.7z'], (path) => {
      trashed.push(path);
      return Promise.resolve();
    });

    expect(outcome).toEqual({ landed: [{ name: 'foo.7z' }], refused: [] });
    expect(trashed).toEqual([archive, sidecar]);
  });

  it('trashes only the archive when the download has no sidecar', async () => {
    const downloadsDir = await makeDownloadsDir();
    const archive = await writeArchive(downloadsDir, 'manual.7z');
    const trashed: string[] = [];

    const outcome = await deleteDownloads(downloadsDir, ['manual.7z'], (path) => {
      trashed.push(path);
      return Promise.resolve();
    });

    expect(outcome).toEqual({ landed: [{ name: 'manual.7z' }], refused: [] });
    expect(trashed).toEqual([archive]);
  });

  it('refuses with the trash’s own reason when the archive cannot go, and never touches the sidecar', async () => {
    const downloadsDir = await makeDownloadsDir();
    await writeArchive(downloadsDir, 'foo.7z');
    await writeSidecar(downloadsDir, 'foo.7z', '[General]\r\n');
    const trashed: string[] = [];

    const outcome = await deleteDownloads(downloadsDir, ['foo.7z'], (path) => {
      trashed.push(path);
      return Promise.reject(new Error('EPERM'));
    });

    expect(outcome).toEqual({ landed: [], refused: [{ item: { name: 'foo.7z' }, reason: 'EPERM' }] });
    expect(trashed).toEqual([join(downloadsDir, 'foo.7z')]);
  });

  // The archive is already gone once the sidecar's trash is attempted, so this failure is not a
  // refusal (ADR-0019: a landed gesture that would show something untrue is logged, not failed).
  it('a sidecar trash failure after the archive landed reports the delete as done, naming the reason', async () => {
    const downloadsDir = await makeDownloadsDir();
    const archive = await writeArchive(downloadsDir, 'foo.7z');
    const sidecar = await writeSidecar(downloadsDir, 'foo.7z', '[General]\r\n');
    const trashed: string[] = [];

    const outcome = await deleteDownloads(downloadsDir, ['foo.7z'], (path) => {
      trashed.push(path);
      if (path === sidecar) return Promise.reject(new Error('EPERM'));
      return Promise.resolve();
    });

    expect(outcome).toEqual({ landed: [{ name: 'foo.7z', metaLeftBehind: 'EPERM' }], refused: [] });
    expect(trashed).toEqual([archive, sidecar]);
  });
});
