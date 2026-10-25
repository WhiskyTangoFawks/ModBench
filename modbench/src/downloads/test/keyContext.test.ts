import { describe, it, expect, vi } from 'vitest';
import {
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString, uriFile,
} from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString,
  Uri: { file: uriFile },
}));

import { DownloadedFileNode, type DownloadsTreeNode } from '../DownloadsProvider';
import { ErrorNode } from '../../drivingLib/errorNode';
import { DOWNLOADS_KEY_ARGS, downloadsCopyValueText, downloadsKeyContext } from '../keyContext';
import { downloadedFileRowFixture } from '../../test/mo2/downloadedFileRowFixture';

describe('what the Downloads palette entries, handed no row, read off the selection', () => {
  const plain = new DownloadedFileNode(downloadedFileRowFixture('plain.7z'));
  const withMeta = new DownloadedFileNode(downloadedFileRowFixture('meta.7z', { hasMeta: true }));
  const excluded = new DownloadedFileNode(downloadedFileRowFixture('excluded.7z', { hasMeta: true, excluded: true }));
  const NOTHING = { singleFile: false, singleFileWithMeta: false, holdsFile: false, holdsIncluded: false, holdsExcluded: false };

  it.each<[string, DownloadsTreeNode[], ReturnType<typeof downloadsKeyContext>]>([
    ['one file with no metadata, for open, delete and exclude', [plain], { ...NOTHING, singleFile: true, holdsFile: true, holdsIncluded: true }],
    ['one file with metadata, for open metadata too', [withMeta], { ...NOTHING, singleFile: true, singleFileWithMeta: true, holdsFile: true, holdsIncluded: true }],
    ['one excluded file, for include and not exclude', [excluded], { ...NOTHING, singleFile: true, singleFileWithMeta: true, holdsFile: true, holdsExcluded: true }],
    ['two files, for neither open', [plain, withMeta], { ...NOTHING, holdsFile: true, holdsIncluded: true }],
    ['an included and an excluded file, for exclude and include both', [plain, excluded], { ...NOTHING, holdsFile: true, holdsIncluded: true, holdsExcluded: true }],
    ['two files with metadata, for no open metadata', [withMeta, excluded], { ...NOTHING, holdsFile: true, holdsIncluded: true, holdsExcluded: true }],
    ['nothing selected, for nothing', [], NOTHING],
    ['an error row, which is no file, for nothing', [new ErrorNode('unreadable')], NOTHING],
  ])('%s', (_case, selection, context) => {
    expect(downloadsKeyContext(selection)).toEqual(context);
  });
});

describe('Downloads\' own text for the catalog\'s copy value', () => {
  const alpha = new DownloadedFileNode(downloadedFileRowFixture('alpha.7z', { displayName: 'Alpha Mod' }));
  const copy = (selection: readonly DownloadsTreeNode[]) => downloadsCopyValueText(() => selection);

  it('is the file name of a right-clicked row, not its display name', () => {
    expect(copy([])(alpha, undefined)).toBe('alpha.7z');
  });

  it('is the selection for the view\'s own Ctrl+C, skipping a row that is no file', () => {
    expect(copy([new ErrorNode('unreadable'), alpha])(DOWNLOADS_KEY_ARGS, undefined)).toBe('alpha.7z');
  });
});
