import { describe, it, expect } from 'vitest';
import {
  buildDownloadRows,
  filterHiddenRows,
  parseDownloadMeta,
  setHiddenInText,
  setInstalledInText,
  sortDownloadRows,
  type DownloadEntry,
  type DownloadRow,
} from './downloads';

describe('parseDownloadMeta', () => {
  it('installed=true -> Installed status', () => {
    expect(parseDownloadMeta('[General]\r\ninstalled=true\r\n').status).toBe('Installed');
  });

  it('uninstalled=true -> Removed status', () => {
    expect(parseDownloadMeta('[General]\r\nuninstalled=true\r\n').status).toBe('Removed');
  });

  it('neither flag, or no .meta text at all -> Downloaded status', () => {
    expect(parseDownloadMeta('[General]\r\ngameName=Fallout4\r\n').status).toBe('Downloaded');
    expect(parseDownloadMeta('').status).toBe('Downloaded');
  });

  it('reads modID as the Nexus mod id', () => {
    expect(parseDownloadMeta('[General]\r\nmodID=12345\r\n').modID).toBe('12345');
  });

  it('treats modID=0 or an absent modID as no id (Visit-on-Nexus gated off)', () => {
    expect(parseDownloadMeta('[General]\r\nmodID=0\r\n').modID).toBeUndefined();
    expect(parseDownloadMeta('[General]\r\ninstalled=true\r\n').modID).toBeUndefined();
  });

  it('reads removed=true as hidden (a separate axis from Status)', () => {
    expect(parseDownloadMeta('[General]\r\nremoved=true\r\n').hidden).toBe(true);
  });

  it('is not hidden when removed is false or absent', () => {
    expect(parseDownloadMeta('[General]\r\nremoved=false\r\n').hidden).toBe(false);
    expect(parseDownloadMeta('[General]\r\ninstalled=true\r\n').hidden).toBe(false);
  });

  // The load-bearing guard for the acceptance criterion: "Removed" Status
  // (uninstalled=true) and hidden (removed=true) are never conflated — they are
  // orthogonal axes derived from different keys.
  it('never conflates the Removed Status with hidden: both flags coexist', () => {
    const meta = parseDownloadMeta('[General]\r\nuninstalled=true\r\nremoved=true\r\n');
    expect(meta.status).toBe('Removed');
    expect(meta.hidden).toBe(true);
  });
});

const row = (name: string, mtimeMs: number, hidden = false): DownloadRow => ({
  name,
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

describe('setHiddenInText', () => {
  it('creates a fresh [General] section with removed=true when there is no .meta text', () => {
    expect(setHiddenInText('', true)).toBe('[General]\r\nremoved=true\r\n');
  });

  it('inserts removed=true after an existing [General] header, preserving other lines', () => {
    const text = '[General]\r\ngameName=Fallout4\r\nmodid=12345\r\n';
    expect(setHiddenInText(text, true)).toBe(
      '[General]\r\nremoved=true\r\ngameName=Fallout4\r\nmodid=12345\r\n',
    );
  });

  it('flips an existing removed=false to true in place, byte-faithful', () => {
    const text = '[General]\r\ngameName=Fallout4\r\nremoved=false\r\nmodid=12345\r\n';
    expect(setHiddenInText(text, true)).toBe(
      '[General]\r\ngameName=Fallout4\r\nremoved=true\r\nmodid=12345\r\n',
    );
  });

  it('is a no-op when removed=true is already present', () => {
    const text = '[General]\r\nremoved=true\r\nmodid=12345\r\n';
    expect(setHiddenInText(text, true)).toBe(text);
  });

  // Unhide: MO2 writes removed=false (setValue), it does not delete the key.
  it('flips removed=true to false in place when unhiding, byte-faithful', () => {
    const text = '[General]\r\ngameName=Fallout4\r\nremoved=true\r\nmodid=12345\r\n';
    expect(setHiddenInText(text, false)).toBe(
      '[General]\r\ngameName=Fallout4\r\nremoved=false\r\nmodid=12345\r\n',
    );
  });
});

describe('setInstalledInText', () => {
  it('creates a fresh [General] section with installed=true when there is no .meta text', () => {
    expect(setInstalledInText('')).toBe('[General]\r\ninstalled=true\r\n');
  });

  it('inserts installed=true after an existing [General] header, preserving other lines', () => {
    const text = '[General]\r\ngameName=Fallout4\r\nmodid=12345\r\n';
    expect(setInstalledInText(text)).toBe(
      '[General]\r\ninstalled=true\r\ngameName=Fallout4\r\nmodid=12345\r\n',
    );
  });

  it('flips an existing installed=false to true in place, byte-faithful', () => {
    const text = '[General]\r\ngameName=Fallout4\r\ninstalled=false\r\nmodid=12345\r\n';
    expect(setInstalledInText(text)).toBe(
      '[General]\r\ngameName=Fallout4\r\ninstalled=true\r\nmodid=12345\r\n',
    );
  });

  it('is a no-op when installed=true is already present', () => {
    const text = '[General]\r\ninstalled=true\r\nmodid=12345\r\n';
    expect(setInstalledInText(text)).toBe(text);
  });
});

describe('buildDownloadRows', () => {
  const entry = (name: string, mtimeMs: number, metaText?: string): DownloadEntry => ({
    name,
    size: 123,
    mtimeMs,
    metaText,
  });

  it('maps a plain archive with no .meta sidecar to a Downloaded row (gating off)', () => {
    const rows = buildDownloadRows([entry('foo.zip', 100)]);
    expect(rows).toEqual([
      { name: 'foo.zip', status: 'Downloaded', size: 123, mtimeMs: 100, hasMeta: false, hidden: false, modID: undefined },
    ]);
  });

  it('flags hasMeta and carries modID for an archive with a .meta sidecar', () => {
    const rows = buildDownloadRows([entry('foo.zip', 100, '[General]\r\nmodID=12345\r\n')]);
    expect(rows[0]).toMatchObject({ name: 'foo.zip', hasMeta: true, modID: '12345' });
  });

  it('flags hasMeta true for a present-but-empty .meta (there is still a file to open)', () => {
    const rows = buildDownloadRows([entry('foo.zip', 100, '')]);
    expect(rows[0]).toMatchObject({ hasMeta: true, modID: undefined });
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

  it('carries the hidden flag through without filtering (filtering is a view concern)', () => {
    const rows = buildDownloadRows([entry('foo.zip', 100, '[General]\r\nremoved=true\r\n')]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'foo.zip', hidden: true });
  });
});
