import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { adapterOver } from '../../test/mo2/adapterOver';
import { writesNamedTo } from '../../repositoriesLib/writeNaming';
import type { InstanceAdapter } from '../instanceAdapter';
import { PROFILE } from './adapterContract';

vi.mock('vscode', () => fakeVscodeModule());

describe('a write through the adapter', () => {
  let root: string;
  let adapter: InstanceAdapter;
  let named: Set<string>;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'modbench-writes-named-'));
    cpSync(join(__dirname, 'fixtures', 'order-instance'), root, { recursive: true });
    adapter = adapterOver(root);
    named = new Set();
    writesNamedTo({ name: (paths) => paths.forEach((path) => named.add(path)), leaveUnnamed: () => undefined });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const inProfile = (file: string): string => join(root, 'profiles', PROFILE, file);

  it.each<[string, (adapter: InstanceAdapter) => Promise<unknown>, (root: string) => string[]]>([
    ['a change to the mod order', (a) => a.changeModOrder(PROFILE, () => [{ kind: 'enable', mod: 'Beta', enabled: true }]), () => [inProfile('modlist.txt')]],
    ['a change to the plugin order', (a) => a.changePluginOrder(PROFILE, () => [{ kind: 'enable', plugin: 'B.esp', enabled: true }]), () => [inProfile('loadorder.txt'), inProfile('plugins.txt')]],
    ['a new mod folder', (a) => a.createModFolder('Fresh'), (r) => [join(r, 'mods', 'Fresh')]],
    ['a change that changes nothing', (a) => a.changeModOrder(PROFILE, () => []), () => []],
  ])('names the files it writes for %s', async (_, write, files) => {
    await write(adapter);

    expect([...named].sort()).toEqual(files(root).sort());
  });
});
