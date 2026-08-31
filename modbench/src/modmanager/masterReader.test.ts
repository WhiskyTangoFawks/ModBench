import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMasters } from './masterReader';
import { buildTes4Buffer } from './test/buildTes4Buffer';

// Scoped to this file only: wraps the handle `open()` returns so a test can spy
// on `.close()` — the only two methods readMasters calls on it are `.read()`
// and `.close()`, so the stub only needs to cover those. Same
// `vi.mock('node:fs/promises', importOriginal)` wrapper idiom as
// Mo2ModlistSource.test.ts.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: vi.fn(
      (async (...args: Parameters<typeof actual.open>) => {
        const handle = await actual.open(...args);
        return { read: handle.read.bind(handle), close: vi.fn(handle.close.bind(handle)) };
      }) as unknown as typeof actual.open,
    ),
  };
});

describe('readMasters', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function writeFixture(buf: Buffer): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'medit-masterreader-'));
    const path = join(dir, 'Test.esp');
    await writeFile(path, buf);
    return path;
  }

  it('extracts multiple masters in file order', async () => {
    const path = await writeFixture(buildTes4Buffer(['Fallout4.esm', 'DLCRobot.esm']));
    expect(await readMasters(path)).toEqual(['Fallout4.esm', 'DLCRobot.esm']);
  });

  it('returns an empty array for a master-less plugin', async () => {
    const path = await writeFixture(buildTes4Buffer([]));
    expect(await readMasters(path)).toEqual([]);
  });

  it('tolerates a DATA subrecord following a MAST without misreading it as a master', async () => {
    const path = await writeFixture(
      buildTes4Buffer(['Fallout4.esm', 'DLCRobot.esm'], { dataAfterFirstMaster: true }),
    );
    expect(await readMasters(path)).toEqual(['Fallout4.esm', 'DLCRobot.esm']);
  });

  it('throws when the file does not start with a TES4 signature', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-masterreader-'));
    const path = join(dir, 'NotAPlugin.esp');
    await writeFile(path, Buffer.alloc(24));
    await expect(readMasters(path)).rejects.toThrow(/TES4/);
  });

  it('closes the file handle both on a successful read and on a TES4 signature failure (#318)', async () => {
    vi.mocked(open).mockClear(); // ignore opens from earlier tests in this file
    const okPath = await writeFixture(buildTes4Buffer([]));
    await readMasters(okPath);

    const badPath = join(dir, 'NotAPlugin.esp');
    await writeFile(badPath, Buffer.alloc(24));
    await expect(readMasters(badPath)).rejects.toThrow();

    const opens = vi.mocked(open).mock.results;
    expect(opens).toHaveLength(2);
    for (const r of opens) {
      const handle = (await r.value) as { close: ReturnType<typeof vi.fn> };
      expect(handle.close).toHaveBeenCalledTimes(1);
    }
  });
});
