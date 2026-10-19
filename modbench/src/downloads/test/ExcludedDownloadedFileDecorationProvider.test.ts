import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { EventEmitter } from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  ThemeColor: class { constructor(public id: string) {} },
  EventEmitter,
  Uri: {
    file: (p: string) => {
      const pathForwardSlashedOnEveryHostWhereTheRealOneIsOnWindowsOnly = p.replaceAll('\\', '/');
      return {
        fsPath: p,
        path: pathForwardSlashedOnEveryHostWhereTheRealOneIsOnWindowsOnly,
        toString: () => `file://${pathForwardSlashedOnEveryHostWhereTheRealOneIsOnWindowsOnly}`,
      };
    },
  },
}));

import * as vscode from 'vscode';
import { ExcludedDownloadedFileDecorationProvider } from '../ExcludedDownloadedFileDecorationProvider';
import { present } from '../../ports/present';

describe('ExcludedDownloadedFileDecorationProvider', () => {
  const instanceRoot = '/instance';
  const downloadsDir = join(instanceRoot, 'downloads');
  const downloadedFileUri = (name: string) => vscode.Uri.file(join(downloadsDir, name));

  it('dims an excluded downloaded file row with the disabled-foreground colour (colour only, no badge)', () => {
    const provider = new ExcludedDownloadedFileDecorationProvider(() => downloadsDir, () => new Set(['excluded.zip']));
    const decoration = present(provider.provideFileDecoration(downloadedFileUri('excluded.zip')), 'the decoration for an excluded downloaded file row');

    expect(decoration.color).toEqual(new vscode.ThemeColor('disabledForeground'));
    expect(decoration.badge).toBeUndefined();
  });

  it('returns undefined for an included downloaded file row', () => {
    const provider = new ExcludedDownloadedFileDecorationProvider(() => downloadsDir, () => new Set(['excluded.zip']));
    expect(provider.provideFileDecoration(downloadedFileUri('included.zip'))).toBeUndefined();
  });

  it('returns undefined for a URI outside downloads/', () => {
    const provider = new ExcludedDownloadedFileDecorationProvider(() => downloadsDir, () => new Set(['excluded.zip']));
    expect(provider.provideFileDecoration(vscode.Uri.file(join(instanceRoot, 'mods', 'SomeMod')))).toBeUndefined();
  });

  it('returns undefined for a sibling path that only shares the downloads/ string prefix, even when slicing it reproduces an excluded download\'s name', () => {
    const downloadsDir = join(instanceRoot, 'downloads');
    const provider = new ExcludedDownloadedFileDecorationProvider(() => downloadsDir, () => new Set(['evil.zip']));
    const uri = vscode.Uri.file(`${downloadsDir}Xevil.zip`);

    expect(provider.provideFileDecoration(uri)).toBeUndefined();
  });

  it('dims a downloaded file row given a backslash-separated Windows fsPath, which a hardcoded / join would not match', () => {
    const winDownloadsDir = String.raw`C:\Instance\downloads`;
    const provider = new ExcludedDownloadedFileDecorationProvider(() => winDownloadsDir, () => new Set(['excluded.zip']));
    const uri = vscode.Uri.file(String.raw`C:\Instance\downloads\excluded.zip`);

    const decoration = present(provider.provideFileDecoration(uri), 'the decoration for the Windows-style row');

    expect(decoration.color).toEqual(new vscode.ThemeColor('disabledForeground'));
  });

  it('decorates nothing while the downloads folder is unresolved, not even a row under the default downloads/', () => {
    const provider = new ExcludedDownloadedFileDecorationProvider(() => undefined, () => new Set(['excluded.zip']));

    expect(provider.provideFileDecoration(downloadedFileUri('excluded.zip'))).toBeUndefined();
  });

  it('follows the downloads folder when download_directory moves while Modbench runs, reading it fresh rather than once at construction', () => {
    let dir = downloadsDir;
    const provider = new ExcludedDownloadedFileDecorationProvider(() => dir, () => new Set(['excluded.zip']));
    const moved = join(instanceRoot, 'MovedDownloads');
    dir = moved;

    const decoration = provider.provideFileDecoration(vscode.Uri.file(join(moved, 'excluded.zip')));

    expect(decoration?.color).toEqual(new vscode.ThemeColor('disabledForeground'));
  });

  describe('onDidChangeFileDecorations', () => {
    it('fires when refresh() is called, so the dim follows a rows change', () => {
      const provider = new ExcludedDownloadedFileDecorationProvider(() => downloadsDir, () => new Set());
      const listener = vi.fn();
      provider.onDidChangeFileDecorations(listener);

      provider.refresh();

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });
});
