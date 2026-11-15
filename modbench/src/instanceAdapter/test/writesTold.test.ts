import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, existsSync, mkdtempSync } from 'node:fs';
import { readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { adapterOver } from '../../test/mo2/adapterOver';
import { writesToldTo } from '../../repositoriesLib/writeNaming';
import { CHECK_THE_DISK, type InstanceAdapter } from '../instanceAdapter';
import { PROFILE } from './adapterContract';

vi.mock('vscode', () => fakeVscodeModule());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

describe('the watch\'s echo of a write the loader was told', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'modbench-writes-echo-'));
    cpSync(join(__dirname, 'fixtures', 'order-instance'), root, { recursive: true });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('reads nothing new, the file standing as it was when the told read took it in', async () => {
    const adapter = adapterOver(root);
    const modlist = join(root, 'profiles', PROFILE, 'modlist.txt');
    const anHourAgo = new Date(Date.now() - 3_600_000);
    writesToldTo({
      told: async (paths) => {
        await Promise.all(paths.map((path) => utimes(path, anHourAgo, anHourAgo)));
        await adapter.reading({ named: [...paths], disk: false });
      },
    });
    await adapter.reading(CHECK_THE_DISK);
    await adapter.changeModOrder(PROFILE, () => [{ kind: 'enable', mod: 'Beta', enabled: true }]);
    const readsOfModlist = (): number => vi.mocked(readFile).mock.calls.filter(([path]) => path === modlist).length;
    const before = readsOfModlist();

    await adapter.reading({ named: [modlist], disk: false });

    expect(readsOfModlist()).toBe(before);
  });
});

describe('a write through the adapter', () => {
  let root: string;
  let adapter: InstanceAdapter;
  let told: Map<string, boolean>;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'modbench-writes-named-'));
    cpSync(join(__dirname, 'fixtures', 'order-instance'), root, { recursive: true });
    adapter = adapterOver(root);
    told = new Map();
    writesToldTo({ told: (paths) => { for (const path of paths) told.set(path, existsSync(path)); return Promise.resolve(); } });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const inProfile = (file: string): string => join(root, 'profiles', PROFILE, file);

  it.each<[string, (adapter: InstanceAdapter) => Promise<unknown>, (root: string) => string[]]>([
    ['a change to the mod order', (a) => a.changeModOrder(PROFILE, () => [{ kind: 'enable', mod: 'Beta', enabled: true }]), () => [inProfile('modlist.txt')]],
    ['a change to the plugin order', (a) => a.changePluginOrder(PROFILE, () => [{ kind: 'enable', plugin: 'B.esp', enabled: true }]), () => [inProfile('loadorder.txt'), inProfile('plugins.txt')]],
    ['a new mod folder', (a) => a.createModFolder('Fresh'), (r) => [join(r, 'mods', 'Fresh')]],
    ['a change that changes nothing', (a) => a.changeModOrder(PROFILE, () => []), () => []],
  ])('tells the loader the files it wrote, once they are written, for %s', async (_, write, files) => {
    await write(adapter);

    expect([...told.keys()].sort()).toEqual(files(root).sort());
    expect([...told.values()].every(Boolean)).toBe(true);
  });
});
