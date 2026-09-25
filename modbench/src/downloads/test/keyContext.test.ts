import { describe, it, expect, vi } from 'vitest';
import {
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString, uriFile,
} from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString,
  Uri: { file: uriFile },
}));

import { DownloadNode } from '../DownloadsProvider';
import { ErrorNode } from '../errorNode';
import { downloadsKeyContext } from '../keyContext';
import { downloadRowFixture } from '../../test/mo2/downloadRowFixture';

// commands.md, Where: a palette entry is handed no row, so its `when` reads what the selection
// holds, and the gesture is absent where it would have nothing to act on.
describe('what the Downloads palette entries read off the selection', () => {
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
