import { describe, it, expect } from 'vitest';
import type { FileOrigin, FileStamp } from '../../instanceAdapter/instanceAdapter';
import { fakeInstanceAdapter, readingFixture } from '../../test/fakeInstanceAdapter';
import { sameCopies, type FileToCompare } from '../sameCopies';

const NS = 1_577_836_800_000_000_000n;
const SHARED = 'textures/shared.dds';

const runtimeOutput = { kind: 'runtimeOutput' } as const;
const mod = (name: string) => ({ kind: 'mod', name } as const);
const NONO = mod('Ñoño\'s Retexture');
const PATCH = mod('Unofficial Fallout 4 Patch');
const pathOf = (origin: FileOrigin): string => `/${origin.kind === 'mod' ? origin.name : 'overwrite'}/${SHARED}`;
const stampOf = (size: number): FileStamp => ({ size: BigInt(size), modifiedNs: NS, changedNs: NS });

function over(copies: Map<FileOrigin, { size: number; hash?: string }>) {
  const entries = [...copies].map(([origin, copy]) => [pathOf(origin), copy] as const);
  const fake = fakeInstanceAdapter(readingFixture(), {
    stamps: new Map(entries.map(([path, { size }]) => [path, stampOf(size)])),
    hashes: new Map(entries.flatMap(([path, { size, hash }]) => (hash === undefined ? [] : [[path, { size, hash }] as const]))),
  });
  const file: FileToCompare = { relativePath: SHARED, providers: [runtimeOutput, NONO, PATCH].map((origin) => ({ origin, path: pathOf(origin) })) };
  return { fake, ask: () => sameCopies(fake.adapter, [file]) };
}

describe('which copies of a file are the same', () => {
  it('tells copies holding the same bytes from copies of the same size holding other bytes', async () => {
    const { ask } = over(new Map([[NONO, { size: 4, hash: 'a' }], [PATCH, { size: 4, hash: 'a' }], [runtimeOutput, { size: 4, hash: 'b' }]]));

    expect(await ask()).toEqual([{
      relativePath: SHARED,
      copies: [
        { origin: runtimeOutput, kind: 'read', sameAs: 0, size: 4n, modifiedNs: NS },
        { origin: NONO, kind: 'read', sameAs: 1, size: 4n, modifiedNs: NS },
        { origin: PATCH, kind: 'read', sameAs: 1, size: 4n, modifiedNs: NS },
      ],
    }]);
  });

  it('gives each copy it read its size and date modified, a copy of a size of its own included', async () => {
    const { ask } = over(new Map([[NONO, { size: 4 }], [PATCH, { size: 2 }], [runtimeOutput, { size: 3 }]]));

    expect(await ask()).toEqual([{
      relativePath: SHARED,
      copies: [
        { origin: runtimeOutput, kind: 'read', sameAs: 0, size: 3n, modifiedNs: NS },
        { origin: NONO, kind: 'read', sameAs: 1, size: 4n, modifiedNs: NS },
        { origin: PATCH, kind: 'read', sameAs: 2, size: 2n, modifiedNs: NS },
      ],
    }]);
  });

  it('reads the contents of only the copies whose size another copy shares, a copy of a size of its own being different', async () => {
    const { ask, fake } = over(new Map([[NONO, { size: 4, hash: 'a' }], [PATCH, { size: 4, hash: 'b' }], [runtimeOutput, { size: 1, hash: 'c' }]]));

    const [answer] = await ask();

    expect(answer?.copies.map((copy) => copy.kind === 'read' && copy.sameAs)).toEqual([0, 1, 2]);
    expect(fake.hashed.sort()).toEqual([pathOf(NONO), pathOf(PATCH)].sort());
  });

  it('answers a copy that cannot be read with the reason, beside the copies that could', async () => {
    const { ask } = over(new Map([[PATCH, { size: 4 }], [runtimeOutput, { size: 4, hash: 'a' }]]));

    const [answer] = await ask();

    const [overwrite, removed, locked] = answer?.copies ?? [];
    expect(overwrite).toEqual({ origin: runtimeOutput, kind: 'read', sameAs: 0, size: 4n, modifiedNs: NS });
    expect(removed).toMatchObject({ origin: NONO, kind: 'unreadable', reason: expect.stringContaining(pathOf(NONO)) as unknown });
    expect(locked).toMatchObject({ origin: PATCH, kind: 'unreadable', reason: expect.stringContaining(pathOf(PATCH)) as unknown });
  });
});
