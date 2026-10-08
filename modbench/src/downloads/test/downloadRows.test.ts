import { describe, it, expect } from 'vitest';
import { downloadContextValue, sortDownloadRows } from '../downloadRows';
import type { DownloadRow } from '../../instanceLoader/instance';

const row = (name: string, mtimeMs: number, excluded = false): DownloadRow => ({
  name,
  displayName: name,
  status: 'Downloaded',
  size: 0,
  mtimeMs,
  hasMeta: false,
  excluded,
  upgrades: [],
});

describe('sortDownloadRows', () => {
  it('sorts by mtimeMs descending (default sort)', () => {
    const rows = [row('a', 100), row('b', 300), row('c', 200)];
    expect(sortDownloadRows(rows, 'mtimeMs', true).map((r) => r.name)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by name ascending when descending=false', () => {
    const rows = [row('banana', 1), row('apple', 2), row('cherry', 3)];
    expect(sortDownloadRows(rows, 'name', false).map((r) => r.name)).toEqual([
      'apple',
      'banana',
      'cherry',
    ]);
  });

  it('sorts by name using the label, not the raw filename, which sorts the opposite way', () => {
    const rows: DownloadRow[] = [
      { ...row('z-file.zip', 1), displayName: 'Alpha' },
      { ...row('a-file.zip', 2), displayName: 'Zeta' },
    ];
    expect(sortDownloadRows(rows, 'name', false).map((r) => r.displayName)).toEqual(['Alpha', 'Zeta']);
    expect(sortDownloadRows(rows, 'name', true).map((r) => r.displayName)).toEqual(['Zeta', 'Alpha']);
  });

  it('is a stable sort by name (label) in both directions: ties keep their relative order', () => {
    const rows: DownloadRow[] = [
      { ...row('a.zip', 1), displayName: 'Same' },
      { ...row('b.zip', 2), displayName: 'Same' },
      { ...row('c.zip', 3), displayName: 'Other' },
    ];
    expect(sortDownloadRows(rows, 'name', false).map((r) => r.name)).toEqual(['c.zip', 'a.zip', 'b.zip']);
    expect(sortDownloadRows(rows, 'name', true).map((r) => r.name)).toEqual(['a.zip', 'b.zip', 'c.zip']);
  });

  it('is a stable sort: ties in the sorted column keep their relative order', () => {
    const rows: DownloadRow[] = [
      { ...row('a', 1), status: 'Downloaded' },
      { ...row('b', 2), status: 'Downloaded' },
      { ...row('c', 3), status: 'Installed' },
    ];
    expect(sortDownloadRows(rows, 'status', false).map((r) => r.name)).toEqual(['a', 'b', 'c']);
  });

  it('is a stable sort descending too: ties in the sorted column keep their relative order', () => {
    const rows: DownloadRow[] = [
      { ...row('a', 1), status: 'Downloaded' },
      { ...row('b', 2), status: 'Downloaded' },
      { ...row('c', 3), status: 'Installed' },
    ];
    expect(sortDownloadRows(rows, 'status', true).map((r) => r.name)).toEqual(['c', 'a', 'b']);
  });
});

describe('downloadContextValue, the space-separated flag string the view/item/context when clauses match', () => {
  const plain: DownloadRow = { name: 'foo.zip', displayName: 'foo.zip', status: 'Downloaded', size: 1, mtimeMs: 1, hasMeta: false, excluded: false, upgrades: [] };

  it('is the base "download" token alone when no optional flag applies', () => {
    expect(downloadContextValue(plain)).toBe('download');
  });

  it('appends hasModID, hasMeta and excluded, in that order, when all three are set', () => {
    const row: DownloadRow = { ...plain, hasMeta: true, excluded: true, modID: '12345' };
    expect(downloadContextValue(row)).toBe('download hasModID hasMeta excluded');
  });

  it('appends only hasModID when just modID is present', () => {
    expect(downloadContextValue({ ...plain, modID: '12345' })).toBe('download hasModID');
  });

  it('appends only hasMeta when just hasMeta is set — gates the openMeta menu entry', () => {
    expect(downloadContextValue({ ...plain, hasMeta: true })).toBe('download hasMeta');
  });

  it('appends only excluded when just excluded is set', () => {
    expect(downloadContextValue({ ...plain, excluded: true })).toBe('download excluded');
  });
});

