import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { EventEmitter } from '../../test/vscodeMock';

// Real `Uri.file` forward-slashes a backslash path only on Windows; this always does, so a
// Windows-style fixture below exercises that conversion on any host.
vi.mock('vscode', () => ({
  ThemeColor: class { constructor(public id: string) {} },
  EventEmitter,
  Uri: {
    file: (p: string) => {
      const path = p.replaceAll('\\', '/');
      return { fsPath: p, path, toString: () => `file://${path}` };
    },
  },
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
    const provider = new ExcludedDownloadDecorationProvider(() => downloadsDir, () => new Set(['excluded.zip']));
    const decoration = present(provider.provideFileDecoration(downloadUri('excluded.zip')), 'the decoration for an excluded download row');

    expect(decoration.color).toEqual(new vscode.ThemeColor('disabledForeground'));
    expect(decoration.badge).toBeUndefined();
  });

  it('returns undefined for an included download row', () => {
    const provider = new ExcludedDownloadDecorationProvider(() => downloadsDir, () => new Set(['excluded.zip']));
    expect(provider.provideFileDecoration(downloadUri('included.zip'))).toBeUndefined();
  });

  it('returns undefined for a URI outside downloads/', () => {
    const provider = new ExcludedDownloadDecorationProvider(() => downloadsDir, () => new Set(['excluded.zip']));
    expect(provider.provideFileDecoration(fakeUri(join(instanceRoot, 'mods', 'SomeMod')))).toBeUndefined();
  });

  // A sibling path that merely shares the "downloads" string prefix must not read as inside
  // downloads/, even when slicing it reproduces a real excluded download's name.
  it('returns undefined for a sibling path that only shares the downloads/ string prefix', () => {
    const downloadsDir = join(instanceRoot, 'downloads');
    const provider = new ExcludedDownloadDecorationProvider(() => downloadsDir, () => new Set(['evil.zip']));
    const uri = fakeUri(`${downloadsDir}Xevil.zip`);

    expect(provider.provideFileDecoration(uri)).toBeUndefined();
  });

  // Rival this rules out: comparing by `.fsPath` with a hardcoded `/` join, which never matches a
  // real Windows `fsPath` (backslash-separated) against a POSIX-style literal.
  it('dims a download row given a Windows-style downloads dir and file path', () => {
    const winDownloadsDir = String.raw`C:\Instance\downloads`;
    const provider = new ExcludedDownloadDecorationProvider(() => winDownloadsDir, () => new Set(['excluded.zip']));
    const uri = vscode.Uri.file(String.raw`C:\Instance\downloads\excluded.zip`);

    const decoration = present(provider.provideFileDecoration(uri), 'the decoration for the Windows-style row');

    expect(decoration.color).toEqual(new vscode.ThemeColor('disabledForeground'));
  });

  // Rival: falling back to a default downloads/ prefix. An unresolved folder decorates nothing,
  // not even a row that would have matched that default.
  it('decorates nothing while the downloads folder is unresolved', () => {
    const provider = new ExcludedDownloadDecorationProvider(() => undefined, () => new Set(['excluded.zip']));

    expect(provider.provideFileDecoration(downloadUri('excluded.zip'))).toBeUndefined();
  });

  // Rival: capturing the folder once at construction, as a fixed instance-root join always
  // could — `download_directory` can move while Modbench runs, and a stale prefix would silently
  // stop matching every row after that.
  it('follows the downloads folder when it moves, reading it fresh rather than once at construction', () => {
    let dir = downloadsDir;
    const provider = new ExcludedDownloadDecorationProvider(() => dir, () => new Set(['excluded.zip']));
    const moved = join(instanceRoot, 'MovedDownloads');
    dir = moved;

    const decoration = provider.provideFileDecoration(fakeUri(join(moved, 'excluded.zip')));

    expect(decoration?.color).toEqual(new vscode.ThemeColor('disabledForeground'));
  });

  describe('onDidChangeFileDecorations', () => {
    it('fires when refresh() is called, so the dim follows a rows change', () => {
      const provider = new ExcludedDownloadDecorationProvider(() => downloadsDir, () => new Set());
      const listener = vi.fn();
      provider.onDidChangeFileDecorations(listener);

      provider.refresh();

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });
});
