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

const resolve = (instanceRoot: string, ini: string, detectors: GameDetectors = NO_DETECTORS) =>
  downloadsDirectoryResolver(detectors)(instanceRoot, ini);

const resolveLogging = (
  instanceRoot: string, ini: string, detectors: GameDetectors, log: (line: string) => void,
) => downloadsDirectoryResolver(detectors, log)(instanceRoot, ini);

describe('the downloads directory resolver', () => {
  const INSTANCE_ROOT = join('/instances', 'My Instance');

  it('defaults to downloads/ under the instance root when the setting is absent', async () => {
    expect(await resolve(INSTANCE_ROOT, iniOf())).toBe(join(INSTANCE_ROOT, 'downloads'));
  });

  it('resolves %BASE_DIR% to the instance root', async () => {
    expect(await resolve(INSTANCE_ROOT, iniOf('%BASE_DIR%/MyDownloads'))).toBe(join(INSTANCE_ROOT, 'MyDownloads'));
  });

  it('takes an absolute path outright, even when it lies outside the instance', async () => {
    const outside = join('/mnt', 'storage', 'downloads');
    expect(await resolve(INSTANCE_ROOT, iniOf(outside))).toBe(outside);
  });

  // Real MO2 resolves a relative value against its own process working directory
  // (settings.cpp:1667-1686), not determinable from the instance alone — Modbench's own choice
  // pending a maintainer answer, not a claim this matches MO2 in every case.
  it('resolves a relative path against the instance root, Modbench\'s own choice absent a determinable MO2 working directory', async () => {
    expect(await resolve(INSTANCE_ROOT, iniOf('MyDownloads'))).toBe(join(INSTANCE_ROOT, 'MyDownloads'));
  });

  it('normalizes a Z:-drive absolute path, as MO2 under Proton writes it, to its POSIX path', async () => {
    const real = join('/home', 'user', 'MyDownloads');
    const winePath = 'Z:' + real.replaceAll('/', '\\');

    expect(await resolve(INSTANCE_ROOT, iniOf(winePath))).toBe(real);
  });

  it("normalizes a C:-drive absolute path into the Proton prefix's drive_c, sharing gamePath's own Wine translation", async () => {
    const prefix = join('/home', 'user', '.steam', 'compatdata', '377160', 'pfx');
    const detectors: GameDetectors = { paths: () => Promise.resolve(null), winePrefix: () => Promise.resolve(prefix) };

    const resolved = await resolve(INSTANCE_ROOT, iniOf('C:\\Games\\MO2\\downloads'), detectors);

    expect(resolved).toBe(join(prefix, 'drive_c', 'Games/MO2/downloads'));
  });

  it('unwraps an @ByteArray(...) value the same way every other ModOrganizer.ini string does', async () => {
    // iniOf already wraps every value it writes in @ByteArray(...); this proves the resolver
    // reads the unwrapped text, not the literal wrapper, by asserting on the unwrapped default.
    expect(await resolve(INSTANCE_ROOT, iniOf('Downloads'))).toBe(join(INSTANCE_ROOT, 'Downloads'));
  });

  // An untranslatable configured folder must not fail the whole Instance recompute (Mods and
  // Plugins do not depend on downloads/) — it falls back to the default folder instead, logging
  // why, the same "no downloads yet" state an absent folder already reaches.
  describe('an untranslatable download_directory falls back rather than rejecting', () => {
    it('falls back to the default folder for a drive letter neither Z nor C', async () => {
      const logged: string[] = [];

      const resolved = await resolveLogging(INSTANCE_ROOT, iniOf('D:\\Games\\downloads'), NO_DETECTORS, (l) => logged.push(l));

      expect(resolved).toBe(join(INSTANCE_ROOT, 'downloads'));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatch(/download_directory/);
      expect(logged[0]).toMatch(/drive/i);
    });

    it('falls back to the default folder for a C: path with no determinable Proton prefix', async () => {
      const logged: string[] = [];
      const detectors: GameDetectors = { paths: () => Promise.resolve(null), winePrefix: () => Promise.resolve(null) };

      const resolved = await resolveLogging(INSTANCE_ROOT, iniOf('C:\\Games\\downloads'), detectors, (l) => logged.push(l));

      expect(resolved).toBe(join(INSTANCE_ROOT, 'downloads'));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatch(/prefix/i);
    });

    it('never rejects — the untranslatable path resolves rather than throwing, with no log callback required', async () => {
      await expect(resolve(INSTANCE_ROOT, iniOf('D:\\Games\\downloads'))).resolves.toBe(join(INSTANCE_ROOT, 'downloads'));
    });
  });
});
