import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { downloadsDirectoryResolver } from '../downloadsDirectory';
import type { GameDetectors } from '../gameDirectory';

const NO_DETECTORS: GameDetectors = {
  paths: () => Promise.resolve(null),
  winePrefix: () => Promise.resolve(null),
};

// The corpus's own game, so autodetection — and Wine prefix detection — have real facts to run
// against when a test needs them.
const iniOf = (downloadDirectory?: string): string =>
  `[General]\r\ngameName=Fallout 4\r\n[Settings]\r\n${
    downloadDirectory === undefined ? '' : `download_directory=@ByteArray(${downloadDirectory})\r\n`}`;

// Only the resolved case's own tests reach into the union — every other test names its own kind.
const resolvedDir = async (
  instanceRoot: string, ini: string, detectors: GameDetectors = NO_DETECTORS,
): Promise<string> => {
  const resolution = await downloadsDirectoryResolver(detectors)(instanceRoot, ini);
  if (resolution.kind !== 'resolved') throw new Error(`expected resolved, got unresolved: ${resolution.reason}`);
  return resolution.downloadsDir;
};

describe('the downloads directory resolver', () => {
  const INSTANCE_ROOT = join('/instances', 'My Instance');

  it('defaults to downloads/ under the instance root when the setting is absent', async () => {
    expect(await resolvedDir(INSTANCE_ROOT, iniOf())).toBe(join(INSTANCE_ROOT, 'downloads'));
  });

  it('resolves %BASE_DIR% to the instance root', async () => {
    expect(await resolvedDir(INSTANCE_ROOT, iniOf('%BASE_DIR%/MyDownloads'))).toBe(join(INSTANCE_ROOT, 'MyDownloads'));
  });

  it('takes an absolute path outright, even when it lies outside the instance', async () => {
    const outside = join('/mnt', 'storage', 'downloads');
    expect(await resolvedDir(INSTANCE_ROOT, iniOf(outside))).toBe(outside);
  });

  // Real MO2 resolves a relative value against its own process working directory
  // (settings.cpp:1667-1686), not determinable from the instance alone — Modbench's own choice
  // pending a maintainer answer, not a claim this matches MO2 in every case.
  it('resolves a relative path against the instance root, Modbench\'s own choice absent a determinable MO2 working directory', async () => {
    expect(await resolvedDir(INSTANCE_ROOT, iniOf('MyDownloads'))).toBe(join(INSTANCE_ROOT, 'MyDownloads'));
  });

  it('normalizes a Z:-drive absolute path, as MO2 under Proton writes it, to its POSIX path', async () => {
    const real = join('/home', 'user', 'MyDownloads');
    const winePath = 'Z:' + real.replaceAll('/', '\\');

    expect(await resolvedDir(INSTANCE_ROOT, iniOf(winePath))).toBe(real);
  });

  it("normalizes a C:-drive absolute path into the Proton prefix's drive_c, sharing gamePath's own Wine translation", async () => {
    const prefix = join('/home', 'user', '.steam', 'compatdata', '377160', 'pfx');
    const detectors: GameDetectors = { paths: () => Promise.resolve(null), winePrefix: () => Promise.resolve(prefix) };

    const resolved = await resolvedDir(INSTANCE_ROOT, iniOf('C:\\Games\\MO2\\downloads'), detectors);

    expect(resolved).toBe(join(prefix, 'drive_c', 'Games/MO2/downloads'));
  });

  it('unwraps an @ByteArray(...) value the same way every other ModOrganizer.ini string does', async () => {
    // iniOf already wraps every value it writes in @ByteArray(...); this proves the resolver
    // reads the unwrapped text, not the literal wrapper, by asserting on the unwrapped default.
    expect(await resolvedDir(INSTANCE_ROOT, iniOf('Downloads'))).toBe(join(INSTANCE_ROOT, 'Downloads'));
  });

  // An untranslatable configured folder answers `unresolved` with why, rather than guessing at
  // the default folder — a folder Modbench cannot resolve is not the folder MO2 names
  // (downloads.md, Which files are rows, story 1).
  describe('an untranslatable download_directory answers unresolved rather than guessing', () => {
    it('answers unresolved, naming the key and the drive, for a drive letter neither Z nor C', async () => {
      const resolution = await downloadsDirectoryResolver(NO_DETECTORS)(INSTANCE_ROOT, iniOf('D:\\Games\\downloads'));

      expect(resolution.kind).toBe('unresolved');
      if (resolution.kind !== 'unresolved') throw new Error('unreachable');
      expect(resolution.reason).toMatch(/download_directory/);
      expect(resolution.reason).toMatch(/drive/i);
    });

    it('answers unresolved, naming the prefix, for a C: path with no determinable Proton prefix', async () => {
      const detectors: GameDetectors = { paths: () => Promise.resolve(null), winePrefix: () => Promise.resolve(null) };

      const resolution = await downloadsDirectoryResolver(detectors)(INSTANCE_ROOT, iniOf('C:\\Games\\downloads'));

      expect(resolution.kind).toBe('unresolved');
      if (resolution.kind !== 'unresolved') throw new Error('unreachable');
      expect(resolution.reason).toMatch(/prefix/i);
    });

    it('never rejects — the untranslatable path answers unresolved rather than throwing', async () => {
      await expect(downloadsDirectoryResolver(NO_DETECTORS)(INSTANCE_ROOT, iniOf('D:\\Games\\downloads')))
        .resolves.toMatchObject({ kind: 'unresolved' });
    });
  });
});
