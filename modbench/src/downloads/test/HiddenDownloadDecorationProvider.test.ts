import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';

vi.mock('vscode', () => ({
  ThemeColor: class { constructor(public id: string) {} },
  Uri: { file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }) },
}));

import * as vscode from 'vscode';
import { HiddenDownloadDecorationProvider } from '../HiddenDownloadDecorationProvider';
import { fakeUri } from '../../test/vscodeMock';
import { present } from '../../ports/present';

describe('HiddenDownloadDecorationProvider', () => {
  const instanceRoot = '/instance';
  const downloadsDir = join(instanceRoot, 'downloads');
  const downloadUri = (name: string) => fakeUri(join(downloadsDir, name));

  it('dims a hidden download row with the disabled-foreground colour (colour only, no badge)', () => {
    const provider = new HiddenDownloadDecorationProvider(downloadsDir, () => new Set(['hidden.zip']));
    const decoration = present(provider.provideFileDecoration(downloadUri('hidden.zip')), 'the decoration for a hidden download row');

    expect(decoration.color).toEqual(new vscode.ThemeColor('disabledForeground'));
    expect(decoration.badge).toBeUndefined();
  });

  it('returns undefined for a visible download row', () => {
    const provider = new HiddenDownloadDecorationProvider(downloadsDir, () => new Set(['hidden.zip']));
    expect(provider.provideFileDecoration(downloadUri('visible.zip'))).toBeUndefined();
  });

  it('returns undefined for a URI outside downloads/', () => {
    const provider = new HiddenDownloadDecorationProvider(downloadsDir, () => new Set(['hidden.zip']));
    expect(provider.provideFileDecoration(fakeUri(join(instanceRoot, 'mods', 'SomeMod')))).toBeUndefined();
  });

  // A sibling path that merely shares the "downloads" string prefix must not read as inside
  // downloads/, even when slicing it reproduces a real hidden download's name.
  it('returns undefined for a sibling path that only shares the downloads/ string prefix', () => {
    const downloadsDir = join(instanceRoot, 'downloads');
    const provider = new HiddenDownloadDecorationProvider(downloadsDir, () => new Set(['evil.zip']));
    const uri = fakeUri(`${downloadsDir}Xevil.zip`);

    expect(provider.provideFileDecoration(uri)).toBeUndefined();
  });
});
