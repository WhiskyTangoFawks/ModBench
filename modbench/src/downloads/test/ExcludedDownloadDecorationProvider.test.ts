import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';

vi.mock('vscode', () => ({
  ThemeColor: class { constructor(public id: string) {} },
  Uri: { file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }) },
}));

import * as vscode from 'vscode';
import { ExcludedDownloadDecorationProvider } from '../ExcludedDownloadDecorationProvider';
import { fakeUri } from '../../test/vscodeMock';
import { present } from '../../ports/present';

describe('ExcludedDownloadDecorationProvider', () => {
  const instanceRoot = '/instance';
  const downloadsDir = join(instanceRoot, 'downloads');
  const downloadUri = (name: string) => fakeUri(join(downloadsDir, name));

  it('dims an excluded download row with the disabled-foreground colour (colour only, no badge)', () => {
    const provider = new ExcludedDownloadDecorationProvider(downloadsDir, () => new Set(['excluded.zip']));
    const decoration = present(provider.provideFileDecoration(downloadUri('excluded.zip')), 'the decoration for an excluded download row');

    expect(decoration.color).toEqual(new vscode.ThemeColor('disabledForeground'));
    expect(decoration.badge).toBeUndefined();
  });

  it('returns undefined for an included download row', () => {
    const provider = new ExcludedDownloadDecorationProvider(downloadsDir, () => new Set(['excluded.zip']));
    expect(provider.provideFileDecoration(downloadUri('included.zip'))).toBeUndefined();
  });

  it('returns undefined for a URI outside downloads/', () => {
    const provider = new ExcludedDownloadDecorationProvider(downloadsDir, () => new Set(['excluded.zip']));
    expect(provider.provideFileDecoration(fakeUri(join(instanceRoot, 'mods', 'SomeMod')))).toBeUndefined();
  });

  // A sibling path that merely shares the "downloads" string prefix must not read as inside
  // downloads/, even when slicing it reproduces a real excluded download's name.
  it('returns undefined for a sibling path that only shares the downloads/ string prefix', () => {
    const downloadsDir = join(instanceRoot, 'downloads');
    const provider = new ExcludedDownloadDecorationProvider(downloadsDir, () => new Set(['evil.zip']));
    const uri = fakeUri(`${downloadsDir}Xevil.zip`);

    expect(provider.provideFileDecoration(uri)).toBeUndefined();
  });
});
