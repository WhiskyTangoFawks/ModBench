import { describe, it, expect } from 'vitest';
import {
  buildDownloadRows,
  downloadContextValue,
  filterHiddenRows,
  parseDownloadMeta,
  setHiddenInText,
  setInstalledInText,
  setUninstalledInText,
  sortDownloadRows,
  type DownloadEntry,
  type DownloadRow,
} from './downloads';

describe('parseDownloadMeta', () => {
  it('installed=true -> Installed status', () => {
    expect(parseDownloadMeta('[General]\r\ninstalled=true\r\n').status).toBe('Installed');
  });

  it('uninstalled=true -> Uninstalled status', () => {
    expect(parseDownloadMeta('[General]\r\nuninstalled=true\r\n').status).toBe('Uninstalled');
  });

  it('neither flag, or no .meta text at all -> Downloaded status', () => {
    expect(parseDownloadMeta('[General]\r\ngameName=Fallout4\r\n').status).toBe('Downloaded');
    expect(parseDownloadMeta('').status).toBe('Downloaded');
  });

  it('reads modID as the Nexus mod id', () => {
    expect(parseDownloadMeta('[General]\r\nmodID=12345\r\n').modID).toBe('12345');
  });

  it('reads name as the friendly display name', () => {
    expect(parseDownloadMeta('[General]\r\nname=Sleep or Save\r\n').name).toBe('Sleep or Save');
  });

  it('reads version', () => {
    expect(parseDownloadMeta('[General]\r\nversion=1.2.3\r\n').version).toBe('1.2.3');
  });

  it('reads the tooltip fields: modName, fileID, gameName, author', () => {
    const meta = parseDownloadMeta(
      '[General]\r\nmodName=Sleep or Save\r\nfileID=456\r\ngameName=Fallout4\r\nauthor=SomeAuthor\r\n',
    );
    expect(meta.modName).toBe('Sleep or Save');
    expect(meta.fileID).toBe('456');
    expect(meta.gameName).toBe('Fallout4');
    expect(meta.author).toBe('SomeAuthor');
  });

  it('name and version are undefined when absent from .meta', () => {
    const meta = parseDownloadMeta('[General]\r\ninstalled=true\r\n');
    expect(meta.name).toBeUndefined();
    expect(meta.version).toBeUndefined();
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

  // The load-bearing guard for the acceptance criterion: the Uninstalled Status
  // (uninstalled=true) and hidden (removed=true) are never conflated — they are
  // orthogonal axes derived from different keys.
  it('never conflates the Uninstalled Status with hidden: both flags coexist', () => {
    const meta = parseDownloadMeta('[General]\r\nuninstalled=true\r\nremoved=true\r\n');
    expect(meta.status).toBe('Uninstalled');
    expect(meta.hidden).toBe(true);
  });

  // Open Meta File (docs/specs/downloads.md:84) is a documented hand-edit affordance —
  // the one of the three QSettings::IniFormat files (.meta / meta.ini / ModOrganizer.ini)
  // with a supported UX path to produce padding a writer never would.
  it('parses a hand-edited .meta with padded key=value spacing the same as the tight form', () => {
    const tight = parseDownloadMeta('[General]\r\ninstalled=true\r\n');
    const padded = parseDownloadMeta('[General]\r\ninstalled = true\r\n');
    expect(padded.status).toBe('Installed');
    expect(padded).toEqual(tight);
  });
});

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

  // MO2 (via Qt's QSettings) always writes CRLF on Windows, but mEdit is not
  // Windows-only — a .meta produced on a platform that writes bare LF must keep
  // its own convention rather than have CRLF forced onto it.
  it('preserves LF-only line endings when inserting after an existing [General] header', () => {
    const text = '[General]\ngameName=Fallout4\n';
    expect(setInstalledInText(text)).toBe('[General]\ninstalled=true\ngameName=Fallout4\n');
  });
});

describe('setUninstalledInText', () => {
  it('creates a fresh [General] section with uninstalled=true when there is no .meta text', () => {
    expect(setUninstalledInText('')).toBe('[General]\r\nuninstalled=true\r\n');
  });

  it('inserts uninstalled=true after an existing [General] header, preserving other lines', () => {
    const text = '[General]\r\ngameName=Fallout4\r\nmodid=12345\r\n';
    expect(setUninstalledInText(text)).toBe(
      '[General]\r\nuninstalled=true\r\ngameName=Fallout4\r\nmodid=12345\r\n',
    );
  });

  it('flips an existing uninstalled=false to true in place, byte-faithful', () => {
    const text = '[General]\r\ngameName=Fallout4\r\nuninstalled=false\r\nmodid=12345\r\n';
    expect(setUninstalledInText(text)).toBe(
      '[General]\r\ngameName=Fallout4\r\nuninstalled=true\r\nmodid=12345\r\n',
    );
  });

  it('is a no-op when uninstalled=true is already present', () => {
    const text = '[General]\r\nuninstalled=true\r\nmodid=12345\r\n';
    expect(setUninstalledInText(text)).toBe(text);
  });

  // MO2 writes installed=true, uninstalled=false on install and uninstalled=true
  // on uninstall WITHOUT clearing installed — both keys carry history.
  it('leaves installed=true in place — it is a separate key, never cleared', () => {
    const text = '[General]\r\ninstalled=true\r\nmodid=12345\r\n';
    expect(setUninstalledInText(text)).toBe(
      '[General]\r\nuninstalled=true\r\ninstalled=true\r\nmodid=12345\r\n',
    );
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

  it('appends hasMeta, hasModID, and hidden, in that order, when all three are set', () => {
    const row: DownloadRow = { ...plain, hasMeta: true, hidden: true, modID: '12345' };
    expect(downloadContextValue(row)).toBe('download hasMeta hasModID hidden');
  });

  it('appends only hasMeta when just hasMeta is set', () => {
    expect(downloadContextValue({ ...plain, hasMeta: true })).toBe('download hasMeta');
  });

  it('appends only hasModID when just modID is present', () => {
    expect(downloadContextValue({ ...plain, modID: '12345' })).toBe('download hasModID');
  });

  it('appends only hidden when just hidden is set', () => {
    expect(downloadContextValue({ ...plain, hidden: true })).toBe('download hidden');
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
      {
        name: 'foo.zip',
        displayName: 'foo.zip',
        status: 'Downloaded',
        size: 123,
        mtimeMs: 100,
        hasMeta: false,
        hidden: false,
        modID: undefined,
      },
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

  // Entries are given out of mtimeMs order on purpose: if the default sort were a
  // no-op (e.g. sorting by the wrong column), a 2-element already-ascending fixture
  // would still pass by coincidence once reversed. This fixture only passes if the
  // rows are genuinely re-sorted by mtimeMs.
  it('defaults to Filetime (mtimeMs) descending', () => {
    const rows = buildDownloadRows([entry('b.zip', 2), entry('a.zip', 1), entry('c.zip', 3)]);
    expect(rows.map((r) => r.name)).toEqual(['c.zip', 'b.zip', 'a.zip']);
  });

  it('carries the hidden flag through without filtering (filtering is a view concern)', () => {
    const rows = buildDownloadRows([entry('foo.zip', 100, '[General]\r\nremoved=true\r\n')]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'foo.zip', hidden: true });
  });

  it('uses the .meta name as displayName when present', () => {
    const rows = buildDownloadRows([entry('foo_1_2_3.zip', 100, '[General]\r\nname=Sleep or Save\r\n')]);
    expect(rows[0].displayName).toBe('Sleep or Save');
  });

  it('falls back to the filename for displayName when .meta has no name', () => {
    const rows = buildDownloadRows([entry('foo.zip', 100, '[General]\r\ninstalled=true\r\n')]);
    expect(rows[0].displayName).toBe('foo.zip');
  });

  it('falls back to the filename for displayName when .meta name is present but empty', () => {
    const rows = buildDownloadRows([entry('foo.zip', 100, '[General]\r\nname=\r\n')]);
    expect(rows[0].displayName).toBe('foo.zip');
  });

  it('produces a complete row (displayName = filename, version absent) when there is no .meta at all', () => {
    const rows = buildDownloadRows([entry('foo.zip', 100)]);
    expect(rows[0].displayName).toBe('foo.zip');
    expect(rows[0].version).toBeUndefined();
  });

  it('carries version through from .meta', () => {
    const rows = buildDownloadRows([entry('foo.zip', 100, '[General]\r\nversion=1.2.3\r\n')]);
    expect(rows[0].version).toBe('1.2.3');
  });
});
