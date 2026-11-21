import { describe, it, expect, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => (await import('./fileSystemCalls')).countingCalls(await importOriginal()));
vi.mock('node:fs/promises', async (importOriginal) => (await import('./fileSystemCalls')).countingCalls(await importOriginal()));

vi.mock('vscode', async () => {
  const { fakeVscodeModule } = await import('./mo2/fakeVscodeWatcher');
  const { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, Uri } = await import('./vscodeMock');
  return {
    ...fakeVscodeModule(), TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, Uri,
    window: { registerFileDecorationProvider: () => ({ dispose: () => undefined }) },
  };
});

import { A_NEW_LOOSE_FILE, costOf, type Change, type Cost } from './scaleGate';

describe('a change costs the same on a small and a large instance', () => {
  it.each<{ change: Change; layer: keyof Cost }>([
    { change: A_NEW_LOOSE_FILE, layer: 'subscribers' },
  ])('$change.name, at the $layer layer', async ({ change, layer }) => {
    const small = await costOf(3, change);
    const large = await costOf(60, change);

    expect(large[layer]).toBe(small[layer]);
  });
});
