import { describe, it, expect, afterEach } from 'vitest';
import type { FileStamp, OriginFile } from '../../instanceAdapter/instanceAdapter';
import { fakeInstanceAdapter, readingFixture } from '../../test/fakeInstanceAdapter';
import { Instance } from '../instance';

const NONO = 'Ñoño\'s Retexture';
const PATCH = 'Unofficial Fallout 4 Patch';
const SHARED = 'textures/shared.dds';
const NS = 1_577_836_800_000_000_000n;

const instances: Instance[] = [];
afterEach(() => {
  for (const instance of instances.splice(0)) instance.dispose();
});

const mod = (name: string) => ({ kind: 'mod', name } as const);
const runtimeOutput = { kind: 'runtimeOutput' } as const;
const modPath = (name: string): string => `/mods/${name}/${SHARED}`;
const OVERWRITE_PATH = `/overwrite/${SHARED}`;

const fileAt = (path: string): OriginFile => ({ relativePath: SHARED, path, sourcePath: path, excluded: false, excludedByName: false });
const stampOf = (size: number): FileStamp => ({ size: BigInt(size), modifiedNs: NS, changedNs: NS });

async function instanceOver(copies: Record<string, { size: number; hash?: string }>, modNames: readonly string[] = [NONO, PATCH]) {
  const reading = readingFixture({
    mods: modNames.map((name) => ({ kind: 'mod', name, enabled: true }) as const),
    modFiles: new Map(modNames.map((name) => [name, { origin: name, folder: `/mods/${name}`, files: [fileAt(modPath(name))], folders: [], notes: [] }])),
    runtimeOutput: { origin: 'overwrite', folder: '/overwrite', files: [fileAt(OVERWRITE_PATH)], folders: [], notes: [] },
  });
  const entries = Object.entries(copies);
  const fake = fakeInstanceAdapter(reading, {
    stamps: new Map(entries.map(([path, { size }]) => [path, stampOf(size)])),
    hashes: new Map(entries.flatMap(([path, { size, hash }]) => (hash === undefined ? [] : [[path, { size, hash }] as const]))),
  });
  const instance = new Instance({
    adapter: fake.adapter,
    window: { state: { focused: true }, onDidChangeWindowState: () => ({ dispose: () => {} }) },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  instances.push(instance);
  await instance.refresh();
  return { instance, fake };
}

describe('Instance — which copies of a file are the same', () => {
  it('tells copies holding the same bytes from copies of the same size holding other bytes', async () => {
    const { instance } = await instanceOver({
      [modPath(NONO)]: { size: 4, hash: 'a' }, [modPath(PATCH)]: { size: 4, hash: 'a' }, [OVERWRITE_PATH]: { size: 4, hash: 'b' },
    });

    expect(await instance.sameCopies([SHARED])).toEqual([{
      relativePath: SHARED,
      copies: [
        { origin: runtimeOutput, kind: 'read', sameAs: 0, size: 4n, modifiedNs: NS },
        { origin: mod(NONO), kind: 'read', sameAs: 1, size: 4n, modifiedNs: NS },
        { origin: mod(PATCH), kind: 'read', sameAs: 1, size: 4n, modifiedNs: NS },
      ],
    }]);
  });

  it('gives each copy it read its size and date modified, a copy of a size of its own included', async () => {
    const { instance } = await instanceOver({ [modPath(NONO)]: { size: 4 }, [modPath(PATCH)]: { size: 2 }, [OVERWRITE_PATH]: { size: 3 } });

    expect(await instance.sameCopies([SHARED])).toEqual([{
      relativePath: SHARED,
      copies: [
        { origin: runtimeOutput, kind: 'read', sameAs: 0, size: 3n, modifiedNs: NS },
        { origin: mod(NONO), kind: 'read', sameAs: 1, size: 4n, modifiedNs: NS },
        { origin: mod(PATCH), kind: 'read', sameAs: 2, size: 2n, modifiedNs: NS },
      ],
    }]);
  });

  it('reads the contents of only the copies whose size another copy shares, a copy of a size of its own being different', async () => {
    const { instance, fake } = await instanceOver({
      [modPath(NONO)]: { size: 4, hash: 'a' }, [modPath(PATCH)]: { size: 4, hash: 'b' }, [OVERWRITE_PATH]: { size: 1, hash: 'c' },
    });

    const [answer] = await instance.sameCopies([SHARED]);

    expect(answer?.copies.map((copy) => copy.kind === 'read' && copy.sameAs)).toEqual([0, 1, 2]);
    expect(fake.hashed.sort()).toEqual([modPath(NONO), modPath(PATCH)].sort());
  });

  it('answers a copy that cannot be read with the reason, beside the copies that could', async () => {
    const { instance } = await instanceOver({ [modPath(PATCH)]: { size: 4 }, [OVERWRITE_PATH]: { size: 4, hash: 'a' } });

    const [answer] = await instance.sameCopies([SHARED]);

    const [overwrite, removed, locked] = answer?.copies ?? [];
    expect(overwrite).toEqual({ origin: runtimeOutput, kind: 'read', sameAs: 0, size: 4n, modifiedNs: NS });
    expect(removed).toMatchObject({ origin: mod(NONO), kind: 'unreadable', reason: expect.stringContaining(modPath(NONO)) as unknown });
    expect(locked).toMatchObject({ origin: mod(PATCH), kind: 'unreadable', reason: expect.stringContaining(modPath(PATCH)) as unknown });
  });

  it('keeps Overwrite\'s copy apart from the copy of a mod named overwrite (ADR-0012)', async () => {
    const { instance } = await instanceOver(
      { [modPath('overwrite')]: { size: 4, hash: 'a' }, [OVERWRITE_PATH]: { size: 4, hash: 'b' } },
      ['overwrite'],
    );

    const [answer] = await instance.sameCopies([SHARED]);

    expect(answer?.copies).toEqual([
      { origin: runtimeOutput, kind: 'read', sameAs: 0, size: 4n, modifiedNs: NS },
      { origin: mod('overwrite'), kind: 'read', sameAs: 1, size: 4n, modifiedNs: NS },
    ]);
  });
});
