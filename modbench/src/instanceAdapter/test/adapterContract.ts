import { cpSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstanceAdapter } from '../instanceAdapter';
import { adapterOver } from '../../test/mo2/adapterOver';
import { fakeInstanceAdapter, readingFixture } from '../../test/fakeInstanceAdapter';

export const PROFILE = 'Default';

const ORDER_INSTANCE = join(__dirname, 'fixtures', 'order-instance');

export interface Subject {
  readonly adapter: InstanceAdapter;
  dispose(): Promise<void>;
}

/** An implementation over the fixture instance; the fake is seeded from MO2's reading of it. */
export interface Implementation {
  readonly name: string;
  subject(): Promise<Subject>;
}

function mo2Instance(): { root: string; adapter: InstanceAdapter } {
  const root = mkdtempSync(join(tmpdir(), 'medit-contract-'));
  cpSync(ORDER_INSTANCE, root, { recursive: true });
  return { root, adapter: adapterOver(root) };
}

const mo2: Implementation = {
  name: 'MO2',
  subject: () => {
    const { root, adapter } = mo2Instance();
    return Promise.resolve({ adapter, dispose: () => rm(root, { recursive: true, force: true }) });
  },
};

const fake: Implementation = {
  name: 'the fake',
  async subject() {
    const { root, adapter } = mo2Instance();
    try {
      const { mods, modGroups, pluginOrder } = await adapter.reading();
      return { adapter: fakeInstanceAdapter(readingFixture({ mods, modGroups, pluginOrder })).adapter, dispose: () => Promise.resolve() };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
};

export const implementations: readonly Implementation[] = [mo2, fake];

export const modOrderOf = async (adapter: InstanceAdapter): Promise<string[]> =>
  (await adapter.reading()).mods.map((entry) => (entry.kind === 'separator' ? `[${entry.name}]` : entry.enabled ? entry.name : `${entry.name} (off)`));

export const pluginOrderOf = async (adapter: InstanceAdapter): Promise<string[]> =>
  (await adapter.reading()).pluginOrder.map((plugin) => (plugin.enabled ? plugin.name : `${plugin.name} (off)`));
