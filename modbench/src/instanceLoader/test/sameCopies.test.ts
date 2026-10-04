import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fakeVscodeModule, watchers } from '../../test/mo2/fakeVscodeWatcher';
import { cloneCorpusFixture, DEFAULT_MODLIST } from '../../test/mo2/corpusFixture';
import { adapterOver, NO_DOWNLOADS, STEADY_WINDOW } from '../../test/mo2/adapterOver';
import { GAME_FOLDER_NOT_FOUND } from '../../test/mo2/gameFolderNotFound';
import type { InstanceAdapter } from '../../instanceAdapter/instanceAdapter';
import { present } from '../../ports/present';

vi.mock('vscode', () => fakeVscodeModule());

import { Instance } from '../instance';
import { SameCopies, type CopiesIn } from '../sameCopies';

const NONO = 'Ñoño\'s Retexture';
const PATCH = 'Unofficial Fallout 4 Patch';
const SHARED = 'textures/shared.dds';

const roots: string[] = [];
const instances: Instance[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const instance of instances.splice(0)) instance.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  watchers.length = 0;
});

function instanceOver(wrap: (adapter: InstanceAdapter) => InstanceAdapter = (adapter) => adapter): { root: string; instance: Instance } {
  const root = cloneCorpusFixture();
  roots.push(root);
  const instance = new Instance({
    adapter: wrap(adapterOver(root, { gameFolder: GAME_FOLDER_NOT_FOUND, downloadedFiles: NO_DOWNLOADS })),
    window: STEADY_WINDOW,
    log: () => {},
    logReadFailure: () => {},
  });
  instances.push(instance);
  return { root, instance };
}

async function writeCopy(root: string, origin: string, relativePath: string, body: string): Promise<string> {
  const path = join(root, origin, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  return path;
}

const mod = (name: string) => ({ kind: 'mod', name } as const);

function digestsRead(read: string[]): (adapter: InstanceAdapter) => InstanceAdapter {
  return (adapter) => ({ ...adapter, contentDigest: (path) => { read.push(path); return adapter.contentDigest(path); } });
}

const MODIFIED_ON_A_WHOLE_SECOND = new Date('2020-01-01T00:00:00Z');

const clockAnHourPastEveryWrite = (): void => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 3_600_000 });
};

async function twoCopiesOfOneSize(read: string[]): Promise<{ instance: Instance; paths: string[] }> {
  const { root, instance } = instanceOver(digestsRead(read));
  const paths = [await writeCopy(root, `mods/${NONO}`, SHARED, 'aaaa'), await writeCopy(root, `mods/${PATCH}`, SHARED, 'aaaa')];
  await instance.refresh();
  return { instance, paths };
}

describe('Instance — which copies of a file are the same', () => {
  it('tells copies holding the same bytes from copies of the same size holding other bytes', async () => {
    const { root, instance } = instanceOver();
    await writeCopy(root, `mods/${NONO}`, SHARED, 'aaaa');
    await writeCopy(root, `mods/${PATCH}`, SHARED, 'aaaa');
    await writeCopy(root, 'overwrite', SHARED, 'bbbb');
    await instance.refresh();

    expect(await instance.sameCopies([SHARED])).toMatchObject([{
      relativePath: SHARED,
      copies: [
        { origin: { kind: 'runtimeOutput' }, kind: 'read', sameAs: 0, size: 4n },
        { origin: mod(NONO), kind: 'read', sameAs: 1, size: 4n },
        { origin: mod(PATCH), kind: 'read', sameAs: 1, size: 4n },
      ],
    }]);
  });

  it('gives each copy it read its size and date modified, a copy of a size of its own included', async () => {
    const { root, instance } = instanceOver();
    const nono = await writeCopy(root, `mods/${NONO}`, SHARED, 'aaaa');
    await writeCopy(root, `mods/${PATCH}`, SHARED, 'bb');
    await utimes(nono, MODIFIED_ON_A_WHOLE_SECOND, MODIFIED_ON_A_WHOLE_SECOND);
    await instance.refresh();

    const [answer] = await instance.sameCopies([SHARED]);

    const stamps = answer?.copies.map((copy) => copy.kind === 'read' && [copy.origin, copy.size]);
    expect(stamps).toEqual([[mod(NONO), 4n], [mod(PATCH), 2n]]);
    expect(answer?.copies[0]).toMatchObject({ modifiedNs: BigInt(MODIFIED_ON_A_WHOLE_SECOND.getTime()) * 1_000_000n });
  });

  it('reads the contents of only the copies whose size another copy shares, a copy of a size of its own being different', async () => {
    const read: string[] = [];
    const { root, instance } = instanceOver(digestsRead(read));
    const nono = await writeCopy(root, `mods/${NONO}`, SHARED, 'aaaa');
    const patch = await writeCopy(root, `mods/${PATCH}`, SHARED, 'bbbb');
    await writeCopy(root, 'overwrite', SHARED, 'a');
    await instance.refresh();

    const [answer] = await instance.sameCopies([SHARED]);

    expect(answer?.copies.map((copy) => copy.kind === 'read' && copy.sameAs)).toEqual([0, 1, 2]);
    expect(read.sort()).toEqual([nono, patch].sort());
  });

  it('answers a copy that cannot be read with the reason, beside the copies that could', async () => {
    const { root, instance } = instanceOver((adapter) => ({
      ...adapter,
      contentDigest: (path) => (path.includes(PATCH) ? Promise.resolve({ kind: 'unreadable', reason: 'locked by the game' }) : adapter.contentDigest(path)),
    }));
    const gone = await writeCopy(root, `mods/${NONO}`, SHARED, 'aaaa');
    await writeCopy(root, `mods/${PATCH}`, SHARED, 'aaaa');
    await writeCopy(root, 'overwrite', SHARED, 'aaaa');
    await instance.refresh();
    await rm(gone);

    const [answer] = await instance.sameCopies([SHARED]);

    const [overwrite, removed, locked] = answer?.copies ?? [];
    expect(overwrite).toMatchObject({ origin: { kind: 'runtimeOutput' }, kind: 'read', sameAs: 0 });
    expect(removed).toMatchObject({ origin: mod(NONO), kind: 'unreadable' });
    expect(removed?.kind === 'unreadable' && removed.reason).toContain('ENOENT');
    expect(locked).toEqual({ origin: mod(PATCH), kind: 'unreadable', reason: 'locked by the game' });
  });

  it('reads no copy again whose stamp is unchanged, a value rebuilt between the asks or not', async () => {
    clockAnHourPastEveryWrite();
    const read: string[] = [];
    const { instance } = await twoCopiesOfOneSize(read);
    await instance.sameCopies([SHARED]);
    await instance.refresh();

    await instance.sameCopies([SHARED]);

    expect(read).toHaveLength(2);
  });

  it('reads again a copy another tool rewrote keeping its size and date modified', async () => {
    clockAnHourPastEveryWrite();
    const { instance, paths: [nono] } = await twoCopiesOfOneSize([]);
    const copy = present(nono, 'the winning copy');
    await utimes(copy, MODIFIED_ON_A_WHOLE_SECOND, MODIFIED_ON_A_WHOLE_SECOND);
    await instance.sameCopies([SHARED]);

    await writeFile(copy, 'bbbb');
    await utimes(copy, MODIFIED_ON_A_WHOLE_SECOND, MODIFIED_ON_A_WHOLE_SECOND);

    const [answer] = await instance.sameCopies([SHARED]);
    expect(answer?.copies.map((c) => c.kind === 'read' && c.sameAs)).toEqual([0, 1]);
  });

  it('reads again a copy whose stamp is within a clock tick of its last read, as a write in that tick may keep the stamp', async () => {
    const read: string[] = [];
    const { instance } = await twoCopiesOfOneSize(read);
    await instance.sameCopies([SHARED]);

    await instance.sameCopies([SHARED]);

    expect(read).toHaveLength(4);
  });

  it('reads a copy once for two asks while its first read is still going', async () => {
    const read: string[] = [];
    const { instance } = await twoCopiesOfOneSize(read);

    await Promise.all([instance.sameCopies([SHARED]), instance.sameCopies([SHARED])]);

    expect(read).toHaveLength(2);
  });

  it('keeps Overwrite\'s copy apart from the copy of a mod named overwrite (ADR-0012)', async () => {
    const { root, instance } = instanceOver();
    const modlist = join(root, DEFAULT_MODLIST);
    await writeFile(modlist, `${await readFile(modlist, 'utf8')}+overwrite\n`);
    await writeCopy(root, 'mods/overwrite', SHARED, 'aaaa');
    await writeCopy(root, 'overwrite', SHARED, 'bbbb');
    await instance.refresh();

    const [answer] = await instance.sameCopies([SHARED]);

    expect(answer?.copies).toMatchObject([
      { origin: { kind: 'runtimeOutput' }, kind: 'read', sameAs: 0 },
      { origin: mod('overwrite'), kind: 'read', sameAs: 1 },
    ]);
  });
});

describe('SameCopies — what it remembers', () => {
  it('reads again a copy that left the value and came back', async () => {
    const stamp = { size: 4n, modifiedNs: 1n, changedNs: 1n };
    const digested: string[] = [];
    const copies = new SameCopies({
      fileStamp: () => Promise.resolve({ kind: 'read', answer: stamp }),
      contentDigest: (path) => { digested.push(path); return Promise.resolve({ kind: 'read', answer: 'd' }); },
    });
    const file = (origin: string) => ({ relativePath: SHARED, sourcePath: `/${origin}/${SHARED}` });
    const valueOf = (...origins: string[]): CopiesIn => ({
      files: new Map([[SHARED, { providers: origins.map((name) => mod(name)) }]]),
      filesByMod: new Map(origins.map((name) => [name, [file(name)]])),
      overwriteFiles: [],
    });
    await copies.of(valueOf('a', 'b'), [SHARED]);
    await copies.of(valueOf('c'), [SHARED]);

    await copies.of(valueOf('a', 'b'), [SHARED]);

    expect(digested).toHaveLength(4);
  });
});
