import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import type { InstanceAdapter } from '../instanceAdapter';
import { adapterOver } from '../../test/mo2/adapterOver';

describe('the folders restore refuses', () => {
  let place: string;
  let adapter: InstanceAdapter;
  const at = (path: string): string => join(place, path);

  beforeAll(async () => {
    place = await realpath(await mkdtemp(join(tmpdir(), 'medit-refused-')));
    await mkdir(at('instance'));
    adapter = adapterOver(at('instance'));
  });
  afterAll(() => rm(place, { recursive: true, force: true }));

  it('joins every reason a folder has, since it can be outside the instance and built by another manifest too', async () => {
    const folders = new Map([['A', at('elsewhere/A')], ['B', at('elsewhere/A')]]);

    expect(await adapter.foldersRefused(folders, ['A'])).toEqual([
      { item: 'A', reason: `was skipped: its folder '${at('elsewhere/A')}' is outside the instance folder; its folder is also built by 'B'.` },
    ]);
  });

  it('answers only the manifests asked, though it compares them with every manifest', async () => {
    const folders = new Map([['A', at('instance/mods/A')], ['B', at('instance/mods/A')], ['C', at('instance/mods/C')]]);

    expect(await adapter.foldersRefused(folders, ['B', 'C'])).toEqual([
      { item: 'B', reason: "was skipped: its folder is also built by 'A'." },
    ]);
  });

  it('leaves a folder inside another to the search for manifests', async () => {
    const folders = new Map([['A', at('instance/mods/A')], ['B', at('instance/mods/A/B')]]);

    expect(await adapter.foldersRefused(folders, ['A', 'B'])).toEqual([]);
  });

  it('resolves the instance folder and each folder once, however many it compares', async () => {
    const folders = new Map(Array.from({ length: 20 }, (_, index) => [`M${index}`, at(`instance/mods/M${index}`)] as const));
    await Promise.all([...folders.values()].map((folder) => mkdir(folder, { recursive: true })));
    vi.mocked(realpath).mockClear();

    await adapter.foldersRefused(folders, [...folders.keys()]);

    expect(vi.mocked(realpath).mock.calls.map(([path]) => String(path)).sort()).toEqual([at('instance'), ...folders.values()].sort());
  });

  it('refuses a folder beside the instance folder whose name starts as the instance folder\'s does', async () => {
    expect(await adapter.foldersRefused(new Map([['A', at('instance-two/A')]]), ['A'])).toEqual([
      { item: 'A', reason: `was skipped: its folder '${at('instance-two/A')}' is outside the instance folder.` },
    ]);
  });
});
