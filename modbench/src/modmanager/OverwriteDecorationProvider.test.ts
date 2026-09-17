import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';

vi.mock('vscode', () => ({
  ThemeColor: class { constructor(public id: string) {} },
  Uri: { file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }) },
}));

import { OverwriteDecorationProvider } from './OverwriteDecorationProvider';
import { fakeUri } from '../test/vscodeMock';
import { present } from '../ports/present';

describe('OverwriteDecorationProvider', () => {
  const instanceRoot = '/instance';
  const overwriteDir = join(instanceRoot, 'overwrite');

  it('tints the overwrite folder URI reddish (gitDecoration.deletedResourceForeground)', () => {
    const provider = new OverwriteDecorationProvider(instanceRoot);
    const decoration = present(
      provider.provideFileDecoration(fakeUri(overwriteDir)),
      'the overwrite folder\'s decoration',
    );

    expect(decoration.color).toEqual({ id: 'gitDecoration.deletedResourceForeground' });
    // No badge and no prefix — the spec scopes this row to a label tint only.
    expect(decoration.badge).toBeUndefined();
  });

  it('returns undefined for any other URI so mod rows are unaffected', () => {
    const provider = new OverwriteDecorationProvider(instanceRoot);
    const otherPath = join(instanceRoot, 'mods', 'SomeMod');
    expect(provider.provideFileDecoration(fakeUri(otherPath))).toBeUndefined();
  });
});
