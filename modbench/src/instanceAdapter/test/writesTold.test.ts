import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { adapterOver } from '../../test/mo2/adapterOver';
import { writesToldTo } from '../../repositoriesLib/writesTold';
import { withLock } from '../files';
import type { InstanceAdapter } from '../instanceAdapter';
import { PROFILE } from './adapterContract';

vi.mock('vscode', () => fakeVscodeModule());

describe('a write through the adapter', () => {
  let root: string;
  let adapter: InstanceAdapter;
  let told: Map<string, boolean>;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'modbench-writes-named-'));
    cpSync(join(__dirname, 'fixtures', 'order-instance'), root, { recursive: true });
    adapter = adapterOver(root);
    told = new Map();
    writesToldTo({ told: (paths) => { for (const path of paths) told.set(path, existsSync(path)); return Promise.resolve({ subscribed: Promise.resolve() }); } });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const inProfile = (file: string): string => join(root, 'profiles', PROFILE, file);

  type Write = [string, (adapter: InstanceAdapter) => Promise<unknown>, (root: string) => string[]];
  const writesUnderALock: Write[] = [
    ['a change to the mod order', (a) => a.changeModOrder(PROFILE, () => [{ kind: 'enable', mod: 'Beta', enabled: true }]), () => [inProfile('modlist.txt')]],
    ['a change to the plugin order', (a) => a.changePluginOrder(PROFILE, () => [{ kind: 'enable', plugin: 'B.esp', enabled: true }]), () => [inProfile('loadorder.txt'), inProfile('plugins.txt')]],
  ];
  const writes: Write[] = [
    ...writesUnderALock,
    ['a new mod folder', (a) => a.createModFolder('Fresh'), (r) => [join(r, 'mods', 'Fresh')]],
    ['the push check', (a) => { execFileSync('git', ['init', '-q', root]); return a.refuseUnpublishedPins(); }, (r) => [join(r, '.git', 'hooks', 'pre-push')]],
    ['a change that changes nothing', (a) => a.changeModOrder(PROFILE, () => []), () => []],
  ];

  it.each(writes)('tells the loader the files it wrote, once they are written, for %s', async (_, write, files) => {
    await write(adapter);

    expect([...told.keys()].sort()).toEqual(files(root).sort());
    expect([...told.values()].every(Boolean)).toBe(true);
  });

  it.each(writesUnderALock)('tells the loader once it holds no lock, so the loader may take the lock of each file it is told of, for %s', async (_, write, files) => {
    const lockedByLoader: string[] = [];
    writesToldTo({ told: async (paths) => {
      await Promise.all(paths.map((path) => withLock(path, () => { lockedByLoader.push(path); return Promise.resolve(); })));
      return { subscribed: Promise.resolve() };
    } });

    await write(adapter);

    expect(lockedByLoader.sort()).toEqual(files(root).sort());
  });
});
