import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => (await import('./fileSystemCalls')).countingCalls(await importOriginal()));

vi.mock('vscode', async () => {
  const { fakeVscodeModule } = await import('./mo2/fakeVscodeWatcher');
  const { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, Uri } = await import('./vscodeMock');
  return {
    ...fakeVscodeModule(), TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, Uri,
    window: { registerFileDecorationProvider: () => ({ dispose: () => undefined }) },
  };
});

import { costOfOneChangedFile, type Cost } from './scaleGate';

describe('one changed file costs the same on a small and a large instance', () => {
  let small: Cost;
  let large: Cost;

  beforeAll(async () => {
    small = await costOfOneChangedFile(3);
    large = await costOfOneChangedFile(60);
  });

  it.each<keyof Cost>(['subscribers'])('at the %s layer', (layer) => {
    expect(large[layer]).toBe(small[layer]);
  });
});
