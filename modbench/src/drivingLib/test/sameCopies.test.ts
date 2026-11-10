import { describe, it, expect } from 'vitest';
import type { FileOrigin } from '../../instanceLoader/instance';
import { fakeInstanceAdapter, readingFixture } from '../../test/fakeInstanceAdapter';
import { sameCopies } from '../sameCopies';
import type { StackedFile } from '../../instanceLoader/fileConflictIndex';
import type { ArchivedCopyRead } from '../archivedCopies';

const NS = 1_577_836_800_000_000_000n;
const SHARED = 'textures/shared.dds';

const runtimeOutput = { kind: 'runtimeOutput' } as const;
const mod = (name: string) => ({ kind: 'mod', name } as const);
const NONO = mod('Ñoño\'s Retexture');
const PATCH = mod('Unofficial Fallout 4 Patch');
const pathOf = (origin: FileOrigin): string => `/${origin.kind === 'mod' ? origin.name : 'overwrite'}/${SHARED}`;
const stampOf = (size: number) => ({ size: BigInt(size), modifiedNs: NS });

function over(copies: readonly (readonly [FileOrigin, { size: number; hash?: string }])[]) {
  const entries = copies.map(([origin, copy]) => [pathOf(origin), copy] as const);
  const fake = fakeInstanceAdapter(readingFixture(), {
    stamps: new Map(entries.map(([path, { size }]) => [path, stampOf(size)])),
    hashes: new Map(entries.flatMap(([path, { size, hash }]) => (hash === undefined ? [] : [[path, { size, hash }] as const]))),
  });
  const file: StackedFile = { relativePath: SHARED, copies: [runtimeOutput, NONO, PATCH].map((origin) => ({ origin, at: { kind: 'loose', path: pathOf(origin) } })) };
  return { fake, ask: () => sameCopies(fake.adapter, NO_ARCHIVES, [file]) };
}

const NO_ARCHIVES = { read: () => Promise.resolve([]) };

describe('which copies of a file are the same', () => {
  it('tells copies holding the same bytes from copies of the same size holding other bytes', async () => {
    const { ask } = over([[NONO, { size: 4, hash: 'a' }], [PATCH, { size: 4, hash: 'a' }], [runtimeOutput, { size: 4, hash: 'b' }]]);

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
    const { ask } = over([[NONO, { size: 4 }], [PATCH, { size: 2 }], [runtimeOutput, { size: 3 }]]);

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
    const { ask, fake } = over([[NONO, { size: 4, hash: 'a' }], [PATCH, { size: 4, hash: 'b' }], [runtimeOutput, { size: 1, hash: 'c' }]]);

    const [answer] = await ask();

    expect(answer?.copies.map((copy) => copy.kind === 'read' && copy.sameAs)).toEqual([0, 1, 2]);
    expect(fake.hashed.sort()).toEqual([pathOf(NONO), pathOf(PATCH)].sort());
  });

  it('answers a copy that cannot be read with the reason, beside the copies that could', async () => {
    const { ask } = over([[PATCH, { size: 4 }], [runtimeOutput, { size: 4, hash: 'a' }]]);

    const [answer] = await ask();

    const [overwrite, removed, locked] = answer?.copies ?? [];
    expect(overwrite).toEqual({ origin: runtimeOutput, kind: 'read', sameAs: 0, size: 4n, modifiedNs: NS });
    expect(removed).toMatchObject({ origin: NONO, kind: 'unreadable', reason: expect.stringContaining(pathOf(NONO)) as unknown });
    expect(locked).toMatchObject({ origin: PATCH, kind: 'unreadable', reason: expect.stringContaining(pathOf(PATCH)) as unknown });
  });
});

describe('which copies of a file are the same, archived copies among them', () => {
  const ARCHIVED_NS = 7n;
  const archivedAt = { kind: 'archived', gameRelease: 'Fallout4', archive: '/Unofficial Fallout 4 Patch/Patch - Main.ba2', file: SHARED } as const;
  const ask = (archived: ArchivedCopyRead, loose: readonly (readonly [FileOrigin, { size: number; hash?: string }])[]) => {
    const fake = fakeInstanceAdapter(readingFixture(), {
      stamps: new Map(loose.map(([origin, { size }]) => [pathOf(origin), stampOf(size)])),
      hashes: new Map(loose.flatMap(([origin, { size, hash }]) => (hash === undefined ? [] : [[pathOf(origin), { size, hash }] as const]))),
    });
    const file: StackedFile = {
      relativePath: SHARED,
      copies: [...loose.map(([origin]) => ({ origin, at: { kind: 'loose', path: pathOf(origin) } as const })), { origin: PATCH, at: archivedAt }],
    };
    return sameCopies(fake.adapter, { read: () => Promise.resolve([archived]) }, [file]);
  };

  it('reads an archived copy at its size and its archive\'s date, the same as a loose copy of the same bytes', async () => {
    const [answer] = await ask(
      { kind: 'read', answer: { size: 4n, modifiedNs: ARCHIVED_NS, hash: 'a' } },
      [[runtimeOutput, { size: 4, hash: 'b' }], [NONO, { size: 4, hash: 'a' }]],
    );

    expect(answer?.copies).toEqual([
      { origin: runtimeOutput, kind: 'read', sameAs: 0, size: 4n, modifiedNs: NS },
      { origin: NONO, kind: 'read', sameAs: 1, size: 4n, modifiedNs: NS },
      { origin: PATCH, kind: 'read', sameAs: 1, size: 4n, modifiedNs: ARCHIVED_NS },
    ]);
  });

  it('answers an archived copy that cannot be read with the reason', async () => {
    const [answer] = await ask({ kind: 'unreadable', reason: 'it is no BA2' }, [[NONO, { size: 4 }]]);

    expect(answer?.copies.at(-1)).toEqual({ origin: PATCH, kind: 'unreadable', reason: 'it is no BA2' });
  });
});
