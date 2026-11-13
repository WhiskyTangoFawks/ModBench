import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { adapterOver } from '../../test/mo2/adapterOver';
import { collectingWrites } from '../../ports/writeNaming';
import type { InstanceAdapter } from '../instanceAdapter';
import { PROFILE } from './adapterContract';

vi.mock('vscode', () => fakeVscodeModule());

describe('the files a write through the adapter names', () => {
  let root: string;
  let adapter: InstanceAdapter;
  let named: string[];
  const writing = (work: () => Promise<unknown>): Promise<unknown> => collectingWrites({ name: (paths) => named.push(...paths), leaveUnnamed: () => undefined }, work);
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'modbench-writes-named-'));
    cpSync(join(__dirname, 'fixtures', 'order-instance'), root, { recursive: true });
    adapter = adapterOver(root);
    named = [];
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('is the mod order file for a change to the mod order', async () => {
    await writing(() => adapter.changeModOrder(PROFILE, () => [{ kind: 'enable', mod: 'Beta', enabled: true }]));

    expect(named).toEqual([join(root, 'profiles', PROFILE, 'modlist.txt')]);
  });

  it('is the plugin order file and its load order file for a change to the plugin order', async () => {
    await writing(() => adapter.changePluginOrder(PROFILE, () => [{ kind: 'enable', plugin: 'B.esp', enabled: true }]));

    expect([...new Set(named)].sort()).toEqual([join(root, 'profiles', PROFILE, 'loadorder.txt'), join(root, 'profiles', PROFILE, 'plugins.txt')]);
  });

  it('is the folder a mod is created in', async () => {
    await writing(() => adapter.createModFolder('Fresh'));

    expect(named).toEqual([join(root, 'mods', 'Fresh')]);
  });

  it('is nothing when the write writes nothing', async () => {
    await writing(() => adapter.changeModOrder(PROFILE, () => []));

    expect(named).toEqual([]);
  });
});
