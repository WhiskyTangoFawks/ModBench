import { describe, it, expect } from 'vitest';
import { downloadedFileContextValue, sortDownloadedFileRows, type DownloadedFileSortColumn } from '../downloadedFileRows';
import type { DownloadedFileRow } from '../../instanceLoader/instance';
import { downloadedFileRowFixture } from '../../test/mo2/downloadedFileRowFixture';

const row = (name: string, over: Partial<DownloadedFileRow> = {}): DownloadedFileRow => downloadedFileRowFixture(name, over);

describe('the order of the Downloads rows', () => {
  const labelled = [row('z-file.zip', { displayName: 'Alpha' }), row('a-file.zip', { displayName: 'Zeta' })];
  const sameLabel = [row('a.zip', { displayName: 'Same' }), row('b.zip', { displayName: 'Same' }), row('c.zip', { displayName: 'Other' })];
  const sameStatus = [row('a', { status: 'Downloaded' }), row('b', { status: 'Downloaded' }), row('c', { status: 'Installed' })];

  it.each<[string, DownloadedFileRow[], DownloadedFileSortColumn, boolean, string[]]>([
    ['by filetime, newest first, the default', [row('a', { mtimeMs: 100 }), row('b', { mtimeMs: 300 }), row('c', { mtimeMs: 200 })], 'mtimeMs', true, ['b', 'c', 'a']],
    ['by name, A to Z', [row('banana'), row('apple'), row('cherry')], 'name', false, ['apple', 'banana', 'cherry']],
    ['by the label, A to Z, not the raw filename, which sorts the opposite way', labelled, 'name', false, ['z-file.zip', 'a-file.zip']],
    ['by the label, Z to A', labelled, 'name', true, ['a-file.zip', 'z-file.zip']],
    ['by the label, A to Z, ties keeping their relative order', sameLabel, 'name', false, ['c.zip', 'a.zip', 'b.zip']],
    ['by the label, Z to A, ties keeping their relative order', sameLabel, 'name', true, ['a.zip', 'b.zip', 'c.zip']],
    ['by status, A to Z, ties keeping their relative order', sameStatus, 'status', false, ['a', 'b', 'c']],
    ['by status, Z to A, ties keeping their relative order', sameStatus, 'status', true, ['c', 'a', 'b']],
  ])('is %s', (_case, rows, column, descending, names) => {
    expect(sortDownloadedFileRows(rows, column, descending).map((r) => r.name)).toEqual(names);
  });
});

describe('the flags of a downloaded file row the view/item/context when clauses match', () => {
  it.each<[string, Partial<DownloadedFileRow>, string]>([
    ['the base "downloadedFile" token alone when no optional flag applies', {}, 'downloadedFile'],
    ['hasModID, hasMeta and excluded, in that order, when all three are set', { hasMeta: true, excluded: true, modID: '12345' }, 'downloadedFile hasModID hasMeta excluded'],
    ['hasFileID, after hasModID, when the metadata holds a file ID', { modID: '12345', fileID: '78' }, 'downloadedFile hasModID hasFileID'],
    ['only hasModID when just modID is present', { modID: '12345' }, 'downloadedFile hasModID'],
    ['only hasMeta when just hasMeta is set, which gates the openMeta menu entry', { hasMeta: true }, 'downloadedFile hasMeta'],
    ['only excluded when just excluded is set', { excluded: true }, 'downloadedFile excluded'],
  ])('are %s', (_case, over, flags) => {
    expect(downloadedFileContextValue(row('foo.zip', over))).toBe(flags);
  });
});
