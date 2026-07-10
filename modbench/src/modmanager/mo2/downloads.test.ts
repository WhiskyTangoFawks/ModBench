import { describe, it, expect } from 'vitest';
import {
  buildDownloadRows,
  parseDownloadMeta,
  sortDownloadRows,
  type DownloadEntry,
  type DownloadRow,
} from './downloads';

describe('parseDownloadMeta', () => {
  it('installed=true -> Installed status', () => {
    expect(parseDownloadMeta('[General]\r\ninstalled=true\r\n')).toEqual({ status: 'Installed' });
  });

  it('uninstalled=true -> Removed status', () => {
    expect(parseDownloadMeta('[General]\r\nuninstalled=true\r\n')).toEqual({ status: 'Removed' });
  });

  it('neither flag, or no .meta text at all -> Downloaded status', () => {
    expect(parseDownloadMeta('[General]\r\ngameName=Fallout4\r\n')).toEqual({ status: 'Downloaded' });
    expect(parseDownloadMeta('')).toEqual({ status: 'Downloaded' });
  });
});

const row = (name: string, mtimeMs: number): DownloadRow => ({
  name,
  status: 'Downloaded',
  size: 0,
  mtimeMs,
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
});

describe('buildDownloadRows', () => {
  const entry = (name: string, mtimeMs: number, metaText?: string): DownloadEntry => ({
    name,
    size: 123,
    mtimeMs,
    metaText,
  });

  it('maps a plain archive with no .meta sidecar to a Downloaded row', () => {
    const rows = buildDownloadRows([entry('foo.zip', 100)]);
    expect(rows).toEqual([{ name: 'foo.zip', status: 'Downloaded', size: 123, mtimeMs: 100 }]);
  });

  it('never turns a .meta file into its own row', () => {
    const rows = buildDownloadRows([
      entry('foo.zip', 100, '[General]\r\ninstalled=true\r\n'),
      entry('foo.zip.meta', 100),
    ]);
    expect(rows.map((r) => r.name)).toEqual(['foo.zip']);
  });

  it('defaults to Filetime (mtimeMs) descending', () => {
    const rows = buildDownloadRows([entry('old.zip', 1), entry('new.zip', 2)]);
    expect(rows.map((r) => r.name)).toEqual(['new.zip', 'old.zip']);
  });
});
