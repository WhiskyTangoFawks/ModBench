import { describe, it, expect } from 'vitest';
import { downloadContextValue, filterArchiveRows, filterHiddenRows, sortDownloadRows } from '../downloadRows';
import type { DownloadRow } from '../../instanceLoader/instance';

const row = (name: string, mtimeMs: number, hidden = false): DownloadRow => ({
  name,
  displayName: name,
  status: 'Downloaded',
  size: 0,
  mtimeMs,
  hasMeta: false,
  hidden,
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

  // downloads.md, Order and view state, story 2: sort by name means the label. The file names
  // here sort opposite the labels, so keying on `name` instead of `displayName` fails this.
  it('sorts by name using the label, not the raw filename', () => {
    const rows: DownloadRow[] = [
      { ...row('z-file.zip', 1), displayName: 'Alpha' },
      { ...row('a-file.zip', 2), displayName: 'Zeta' },
    ];
    expect(sortDownloadRows(rows, 'name', false).map((r) => r.displayName)).toEqual(['Alpha', 'Zeta']);
    expect(sortDownloadRows(rows, 'name', true).map((r) => r.displayName)).toEqual(['Zeta', 'Alpha']);
  });

  // Ties in the label keep their relative order in both directions, same guarantee the
  // status-column stability tests below cover.
  it('is a stable sort by name (label) in both directions: ties keep their relative order', () => {
    const rows: DownloadRow[] = [
      { ...row('a.zip', 1), displayName: 'Same' },
      { ...row('b.zip', 2), displayName: 'Same' },
      { ...row('c.zip', 3), displayName: 'Other' },
    ];
    expect(sortDownloadRows(rows, 'name', false).map((r) => r.name)).toEqual(['c.zip', 'a.zip', 'b.zip']);
    expect(sortDownloadRows(rows, 'name', true).map((r) => r.name)).toEqual(['a.zip', 'b.zip', 'c.zip']);
  });

  // Stable sort: rows tied on the sorted column (e.g. two Downloaded entries) keep
  // their relative order rather than being reshuffled against each other, while a
  // genuinely different value (Installed) still sorts to its correct place.
  it('is a stable sort: ties in the sorted column keep their relative order', () => {
    const rows: DownloadRow[] = [
      { ...row('a', 1), status: 'Downloaded' },
      { ...row('b', 2), status: 'Downloaded' },
      { ...row('c', 3), status: 'Installed' },
    ];
    expect(sortDownloadRows(rows, 'status', false).map((r) => r.name)).toEqual(['a', 'b', 'c']);
  });

  // Descending must also be stable: negating the comparator, not reversing the
  // sorted array, so ties (the Downloaded pair) keep their relative order while
  // the genuinely different value (Installed) still sorts to its correct place.
  it('is a stable sort descending too: ties in the sorted column keep their relative order', () => {
    const rows: DownloadRow[] = [
      { ...row('a', 1), status: 'Downloaded' },
      { ...row('b', 2), status: 'Downloaded' },
      { ...row('c', 3), status: 'Installed' },
    ];
    expect(sortDownloadRows(rows, 'status', true).map((r) => r.name)).toEqual(['c', 'a', 'b']);
  });
});

describe('filterHiddenRows', () => {
  const rows = [row('visible.zip', 1, false), row('hidden.zip', 2, true)];

  it('excludes hidden rows by default (show-hidden off)', () => {
    expect(filterHiddenRows(rows, false).map((r) => r.name)).toEqual(['visible.zip']);
  });

  it('includes hidden rows when show-hidden is on, leaving the hidden flag intact', () => {
    const shown = filterHiddenRows(rows, true);
    expect(shown.map((r) => r.name)).toEqual(['visible.zip', 'hidden.zip']);
    expect(shown.find((r) => r.name === 'hidden.zip')?.hidden).toBe(true);
  });
});

describe('filterArchiveRows', () => {
  it('keeps only rows install can extract, dropping a readme, a subfolder and an .unfinished file', () => {
    const rows = [
      row('ArmorPack-1-0.zip', 1), row('ReadMe.txt', 2), row('Textures', 3),
      row('ArmorPack-1-0.rar.unfinished', 4),
    ];
    expect(filterArchiveRows(rows).map((r) => r.name)).toEqual(['ArmorPack-1-0.zip']);
  });

  it('compares the extension case-insensitively', () => {
    expect(filterArchiveRows([row('ArmorPack-1-0.ZIP', 1)]).map((r) => r.name)).toEqual(['ArmorPack-1-0.ZIP']);
  });

  it('keeps every extension install can extract: .zip, .7z and .rar', () => {
    const rows = [row('a.zip', 1), row('b.7z', 2), row('c.rar', 3)];
    expect(filterArchiveRows(rows).map((r) => r.name)).toEqual(['a.zip', 'b.7z', 'c.rar']);
  });
});

// The row's right-click menu is a native `view/item/context` contribution,
// gated by this space-separated `contextValue` flag string and `viewItem =~ /\bflag\b/` `when`
// clauses.
describe('downloadContextValue', () => {
  const plain: DownloadRow = { name: 'foo.zip', displayName: 'foo.zip', status: 'Downloaded', size: 1, mtimeMs: 1, hasMeta: false, hidden: false };

  it('is the base "download" token alone when no optional flag applies', () => {
    expect(downloadContextValue(plain)).toBe('download');
  });

  it('appends hasModID, hasMeta and hidden, in that order, when all three are set', () => {
    const row: DownloadRow = { ...plain, hasMeta: true, hidden: true, modID: '12345' };
    expect(downloadContextValue(row)).toBe('download hasModID hasMeta hidden');
  });

  it('appends only hasModID when just modID is present', () => {
    expect(downloadContextValue({ ...plain, modID: '12345' })).toBe('download hasModID');
  });

  it('appends only hasMeta when just hasMeta is set — gates the openMeta menu entry', () => {
    expect(downloadContextValue({ ...plain, hasMeta: true })).toBe('download hasMeta');
  });

  it('appends only hidden when just hidden is set', () => {
    expect(downloadContextValue({ ...plain, hidden: true })).toBe('download hidden');
  });
});

