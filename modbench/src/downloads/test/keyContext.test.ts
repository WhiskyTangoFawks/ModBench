import { describe, it, expect, vi } from 'vitest';
import {
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString, uriFile,
} from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString,
  Uri: { file: uriFile },
}));

import { DownloadNode } from '../DownloadsProvider';
import { ErrorNode } from '../../drivingLib/errorNode';
import { DOWNLOADS_KEY_ARGS, downloadsCopyValueText, downloadsKeyContext } from '../keyContext';
import { downloadRowFixture } from '../../test/mo2/downloadRowFixture';

describe('what the Downloads palette entries, handed no row, read off the selection', () => {
  const plain = new DownloadNode(downloadRowFixture('plain.7z'));
  const withMeta = new DownloadNode(downloadRowFixture('meta.7z', { hasMeta: true }));
  const excluded = new DownloadNode(downloadRowFixture('excluded.7z', { hasMeta: true, excluded: true }));

  it('open sees exactly one selected file', () => {
    expect(downloadsKeyContext([plain]).singleFile).toBe(true);
    expect(downloadsKeyContext([plain, withMeta]).singleFile).toBe(false);
    expect(downloadsKeyContext([]).singleFile).toBe(false);
    expect(downloadsKeyContext([new ErrorNode('unreadable')]).singleFile).toBe(false);
  });

  it('open .meta sees exactly one selected file that has a .meta', () => {
    expect(downloadsKeyContext([withMeta]).singleFileWithMeta).toBe(true);
    expect(downloadsKeyContext([plain]).singleFileWithMeta).toBe(false);
    expect(downloadsKeyContext([withMeta, excluded]).singleFileWithMeta).toBe(false);
  });

  it('delete sees any selected file', () => {
    expect(downloadsKeyContext([plain, excluded]).holdsFile).toBe(true);
    expect(downloadsKeyContext([]).holdsFile).toBe(false);
  });

  it('exclude sees a selected file not excluded, and include one that is', () => {
    expect(downloadsKeyContext([plain, excluded])).toMatchObject({ holdsIncluded: true, holdsExcluded: true });
    expect(downloadsKeyContext([excluded])).toMatchObject({ holdsIncluded: false, holdsExcluded: true });
    expect(downloadsKeyContext([plain])).toMatchObject({ holdsIncluded: true, holdsExcluded: false });
  });
});

describe('Downloads\' own text for the catalog\'s copy value', () => {
  const alpha = new DownloadNode(downloadRowFixture('alpha.7z', { displayName: 'Alpha Mod' }));
  const beta = new DownloadNode(downloadRowFixture('beta.7z'));
  const copy = (selection: readonly (DownloadNode | ErrorNode)[]) => downloadsCopyValueText(() => selection);

  it('is the file name of a right-clicked row, not its display name', () => {
    expect(copy([])(alpha, undefined)).toBe('alpha.7z');
  });

  it('is one file name to a line over the selection a menu hands over', () => {
    expect(copy([])(beta, [alpha, beta])).toBe('alpha.7z\nbeta.7z');
  });

  it('is the view\'s selection for its Ctrl+C, which names the view', () => {
    expect(copy([alpha, beta])(DOWNLOADS_KEY_ARGS, undefined)).toBe('alpha.7z\nbeta.7z');
  });

  it('is empty text for its own Ctrl+C with nothing selected, and skips a row that is no file', () => {
    expect(copy([])(DOWNLOADS_KEY_ARGS, undefined)).toBe('');
    expect(copy([new ErrorNode('unreadable'), alpha])(DOWNLOADS_KEY_ARGS, undefined)).toBe('alpha.7z');
  });

  it('defers on an invocation of another surface', () => {
    expect(copy([alpha])(undefined, undefined)).toBeUndefined();
    expect(copy([alpha])({ view: 'modbench.modList' }, undefined)).toBeUndefined();
    expect(copy([alpha])({ kind: 'mod' }, undefined)).toBeUndefined();
  });
});
