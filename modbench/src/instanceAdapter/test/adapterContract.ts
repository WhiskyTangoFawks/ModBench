import { cpSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstanceAdapter } from '../instanceAdapter';
import { adapterOver } from '../../test/mo2/adapterOver';
import { fakeInstanceAdapter } from '../../test/fakeInstanceAdapter';

export const PROFILE = 'Default';

export interface Subject {
  readonly adapter: InstanceAdapter;
  dispose(): Promise<void>;
}

interface Implementation {
  readonly name: string;
  subject(): Promise<Subject>;
}

function mo2Instance(fixture: string): { root: string; adapter: InstanceAdapter } {
  const root = mkdtempSync(join(tmpdir(), 'medit-contract-'));
  cpSync(join(__dirname, 'fixtures', fixture), root, { recursive: true });
  return { root, adapter: adapterOver(root) };
}

export const implementationsOver = (fixture: string): readonly Implementation[] => [
  {
    name: 'MO2',
    subject: () => {
      const { root, adapter } = mo2Instance(fixture);
      return Promise.resolve({ adapter, dispose: () => rm(root, { recursive: true, force: true }) });
    },
  },
  {
    name: 'the fake',
    async subject() {
      const { root, adapter } = mo2Instance(fixture);
      try {
        return { adapter: fakeInstanceAdapter(await adapter.reading()).adapter, dispose: () => Promise.resolve() };
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  },
];

export const implementations = implementationsOver('order-instance');

export const modOrderOf = async (adapter: InstanceAdapter): Promise<string[]> =>
  (await adapter.reading()).mods.map((entry) => (entry.kind === 'separator' ? `[${entry.name}]` : entry.enabled ? entry.name : `${entry.name} (off)`));

export const pluginOrderOf = async (adapter: InstanceAdapter): Promise<string[]> =>
  (await adapter.reading()).pluginOrder.map((plugin) => (plugin.enabled ? plugin.name : `${plugin.name} (off)`));
