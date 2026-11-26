import { describe, it, expect, vi } from 'vitest';
import { fakeVscodeModule } from '../../../../test/mo2/fakeVscodeWatcher';
import { expectKind } from '../../../../test/expectKind';
import { mo2InstanceHolding } from '../../../test/instanceOnDisk';

vi.mock('vscode', () => fakeVscodeModule());

async function modIdOf(name: string, meta?: string): Promise<string | undefined> {
  const { adapter } = mo2InstanceHolding({ [`downloads/${name}`]: 'bytes', ...meta === undefined ? {} : { [`downloads/${name}.meta`]: meta } });
  return expectKind(await adapter.downloadedFileQuery(name), 'read').answer?.modID;
}

describe('the Nexus mod ID an install gives a mod', () => {
  it.each([
    ['Harder VATS-1234-1-0-1700000000.7z', '1234'],
    ['Harder VATS-1234-1-0.zip', '1234'],
    ['Some_Mod v1.2-56789-1-2.rar', '56789'],
    ['Harder VATS-1-1-0.7z', undefined],
    ['Harder VATS-01234-1-0.7z', undefined],
    ['Harder VATS 1.0.7z', undefined],
    ['Harder VATS-1234-1-0.esp', undefined],
    ['Harder VATS-99999999999-1-0.7z', undefined],
  ])('is read from the name %s, when the metadata has none, as %s', async (name, expected) => {
    expect(await modIdOf(name)).toBe(expected);
  });

  it('is the metadata\'s over the name\'s', async () => {
    expect(await modIdOf('Harder VATS-1234-1-0.7z', '[General]\r\nmodID=111\r\n')).toBe('111');
  });
});
