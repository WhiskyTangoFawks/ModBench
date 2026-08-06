import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';

vi.mock('vscode', () => ({
  ThemeColor: class { constructor(public id: string) {} },
  Uri: { file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }) },
}));

import { HiddenDownloadDecorationProvider } from './HiddenDownloadDecorationProvider';

describe('HiddenDownloadDecorationProvider (#238)', () => {
  const instanceRoot = '/instance';
  const downloadUri = (name: string) => ({ fsPath: join(instanceRoot, 'downloads', name) } as never);

  it('dims a hidden download row (colour only, no badge)', () => {
    const provider = new HiddenDownloadDecorationProvider(instanceRoot, () => new Set(['hidden.zip']));
    const decoration = provider.provideFileDecoration(downloadUri('hidden.zip'));

    expect(decoration).toBeDefined();
    expect(decoration!.color).toBeDefined();
    expect(decoration!.badge).toBeUndefined();
  });

  it('returns undefined for a visible download row', () => {
    const provider = new HiddenDownloadDecorationProvider(instanceRoot, () => new Set(['hidden.zip']));
    expect(provider.provideFileDecoration(downloadUri('visible.zip'))).toBeUndefined();
  });

  it('returns undefined for a URI outside downloads/', () => {
    const provider = new HiddenDownloadDecorationProvider(instanceRoot, () => new Set(['hidden.zip']));
    expect(provider.provideFileDecoration({ fsPath: join(instanceRoot, 'mods', 'SomeMod') } as never)).toBeUndefined();
  });
});
