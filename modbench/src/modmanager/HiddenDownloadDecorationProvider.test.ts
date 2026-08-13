import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';

vi.mock('vscode', () => ({
  ThemeColor: class { constructor(public id: string) {} },
  Uri: { file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }) },
}));

import * as vscode from 'vscode';
import { HiddenDownloadDecorationProvider } from './HiddenDownloadDecorationProvider';

describe('HiddenDownloadDecorationProvider (#238)', () => {
  const instanceRoot = '/instance';
  const downloadUri = (name: string) => ({ fsPath: join(instanceRoot, 'downloads', name) } as never);

  it('dims a hidden download row with the disabled-foreground colour (colour only, no badge)', () => {
    const provider = new HiddenDownloadDecorationProvider(instanceRoot, () => new Set(['hidden.zip']));
    const decoration = provider.provideFileDecoration(downloadUri('hidden.zip'));

    expect(decoration).toBeDefined();
    expect(decoration!.color).toEqual(new vscode.ThemeColor('disabledForeground'));
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

  // The startsWith check anchors on downloadsDir + '/', not downloadsDir alone: a sibling
  // path that merely shares the "downloads" string prefix (e.g. an unrelated file placed
  // right after it in the instance root) must never be treated as inside downloads/, even
  // when slicing its path happens to reproduce a real hidden download's name.
  it('returns undefined for a sibling path that only shares the downloads/ string prefix', () => {
    const downloadsDir = join(instanceRoot, 'downloads');
    const provider = new HiddenDownloadDecorationProvider(instanceRoot, () => new Set(['evil.zip']));
    const uri = { fsPath: `${downloadsDir}Xevil.zip` } as never;

    expect(provider.provideFileDecoration(uri)).toBeUndefined();
  });
});
