import { describe, it, expect } from 'vitest';
import { downloadedFileContextValue, sortDownloadedFileRows } from '../downloadedFileRows';
import type { DownloadedFileRow } from '../../instanceLoader/instance';

const row = (name: string, mtimeMs: number, excluded = false): DownloadedFileRow => ({
  name,
  displayName: name,
  status: 'Downloaded',
  size: 0,
  mtimeMs,
  hasMeta: false,
  excluded,
  upgrades: [],
});

describe('sortDownloadedFileRows', () => {
  it('sorts by mtimeMs descending (default sort)', () => {
    const rows = [row('a', 100), row('b', 300), row('c', 200)];
    expect(sortDownloadedFileRows(rows, 'mtimeMs', true).map((r) => r.name)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by name ascending when descending=false', () => {
    const rows = [row('banana', 1), row('apple', 2), row('cherry', 3)];
    expect(sortDownloadedFileRows(rows, 'name', false).map((r) => r.name)).toEqual([
      'apple',
      'banana',
      'cherry',
    ]);
  });

  it('sorts by name using the label, not the raw filename, which sorts the opposite way', () => {
    const rows: DownloadedFileRow[] = [
      { ...row('z-file.zip', 1), displayName: 'Alpha' },
      { ...row('a-file.zip', 2), displayName: 'Zeta' },
    ];
    expect(sortDownloadedFileRows(rows, 'name', false).map((r) => r.displayName)).toEqual(['Alpha', 'Zeta']);
    expect(sortDownloadedFileRows(rows, 'name', true).map((r) => r.displayName)).toEqual(['Zeta', 'Alpha']);
  });

  it('is a stable sort by name (label) in both directions: ties keep their relative order', () => {
    const rows: DownloadedFileRow[] = [
      { ...row('a.zip', 1), displayName: 'Same' },
      { ...row('b.zip', 2), displayName: 'Same' },
      { ...row('c.zip', 3), displayName: 'Other' },
    ];
    expect(sortDownloadedFileRows(rows, 'name', false).map((r) => r.name)).toEqual(['c.zip', 'a.zip', 'b.zip']);
    expect(sortDownloadedFileRows(rows, 'name', true).map((r) => r.name)).toEqual(['a.zip', 'b.zip', 'c.zip']);
  });

  it('is a stable sort: ties in the sorted column keep their relative order', () => {
    const rows: DownloadedFileRow[] = [
      { ...row('a', 1), status: 'Downloaded' },
      { ...row('b', 2), status: 'Downloaded' },
      { ...row('c', 3), status: 'Installed' },
    ];
    expect(sortDownloadedFileRows(rows, 'status', false).map((r) => r.name)).toEqual(['a', 'b', 'c']);
  });

  it('is a stable sort descending too: ties in the sorted column keep their relative order', () => {
    const rows: DownloadedFileRow[] = [
      { ...row('a', 1), status: 'Downloaded' },
      { ...row('b', 2), status: 'Downloaded' },
      { ...row('c', 3), status: 'Installed' },
    ];
    expect(sortDownloadedFileRows(rows, 'status', true).map((r) => r.name)).toEqual(['c', 'a', 'b']);
  });
});

describe('downloadedFileContextValue, the space-separated flag string the view/item/context when clauses match', () => {
  const plain: DownloadedFileRow = { name: 'foo.zip', displayName: 'foo.zip', status: 'Downloaded', size: 1, mtimeMs: 1, hasMeta: false, excluded: false, upgrades: [] };

  it('is the base "downloadedFile" token alone when no optional flag applies', () => {
    expect(downloadedFileContextValue(plain)).toBe('downloadedFile');
  });

  it('appends hasModID, hasMeta and excluded, in that order, when all three are set', () => {
    const row: DownloadedFileRow = { ...plain, hasMeta: true, excluded: true, modID: '12345' };
    expect(downloadedFileContextValue(row)).toBe('downloadedFile hasModID hasMeta excluded');
  });

  it('appends hasFileID, after hasModID, when the metadata holds a file ID', () => {
    expect(downloadedFileContextValue({ ...plain, modID: '12345', fileID: '78' })).toBe('downloadedFile hasModID hasFileID');
  });

  it('appends only hasModID when just modID is present', () => {
    expect(downloadedFileContextValue({ ...plain, modID: '12345' })).toBe('downloadedFile hasModID');
  });

  it('appends only hasMeta when just hasMeta is set — gates the openMeta menu entry', () => {
    expect(downloadedFileContextValue({ ...plain, hasMeta: true })).toBe('downloadedFile hasMeta');
  });

  it('appends only excluded when just excluded is set', () => {
    expect(downloadedFileContextValue({ ...plain, excluded: true })).toBe('downloadedFile excluded');
  });
});

