import { describe, it, expect } from 'vitest';
import {
  buildDownloadRows,
  modsByInstallationFile,
  parseDownloadMeta,
  setHiddenInText,
  setInstalledInText,
  setUninstalledInText,
  type DownloadEntry,
  type DownloadRow,
} from '../downloads';
import { present } from '../../ports/present';

// Most parseDownloadMeta cases drive buildDownloadRows, its one caller — Installed stays a
// direct call below, since buildDownloadRows's installedInto override reads any sidecarStatus
// as 'Installed' once corroborated (setInstalledInText's own round-trip test).
const rowFor = (metaText: string): DownloadRow =>
  present(buildDownloadRows([{ name: 'foo.zip', size: 0, mtimeMs: 0, metaText }], new Map())[0], 'the sole built row');

describe('parseDownloadMeta, through buildDownloadRows', () => {
  it('uninstalled=true -> Uninstalled status', () => {
    expect(rowFor('[General]\r\nuninstalled=true\r\n').status).toBe('Uninstalled');
  });

  it('reads the tooltip fields: modName, gameName, author', () => {
    const row = rowFor('[General]\r\nmodName=Sleep or Save\r\ngameName=Fallout4\r\nauthor=SomeAuthor\r\n');
    expect(row.modName).toBe('Sleep or Save');
    expect(row.gameName).toBe('Fallout4');
    expect(row.author).toBe('SomeAuthor');
  });

  it('treats modID=0 as no id, same as an absent modID (Visit-on-Nexus gated off)', () => {
    expect(rowFor('[General]\r\nmodID=0\r\n').modID).toBeUndefined();
  });

  it('treats fileID=0 as no id, same as an absent fileID', () => {
    expect(rowFor('[General]\r\nfileID=0\r\n').fileID).toBeUndefined();
  });

  it('is not excluded when removed is explicitly false', () => {
    expect(rowFor('[General]\r\nremoved=false\r\n').excluded).toBe(false);
  });

  // The load-bearing guard for the acceptance criterion: the Uninstalled Status
  // (uninstalled=true) and hidden (removed=true) are never conflated — they are
  // orthogonal axes derived from different keys.
  it('never conflates the Uninstalled Status with excluded: both flags coexist', () => {
    const row = rowFor('[General]\r\nuninstalled=true\r\nremoved=true\r\n');
    expect(row.status).toBe('Uninstalled');
    expect(row.excluded).toBe(true);
  });

  // A .meta hand-edited after open .meta (downloads.md, Menus and keys) can pad key=value spacing a writer never
  // would. modID, not an Installed-status key, stays clear of the seam gap noted above.
  it('parses a hand-edited .meta with padded key=value spacing the same as the tight form', () => {
    const tight = rowFor('[General]\r\nmodID=12345\r\n');
    const padded = rowFor('[General]\r\nmodID = 12345\r\n');
    expect(padded.modID).toBe('12345');
    expect(padded).toEqual(tight);
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
  it('creates a fresh [General] section with both keys when there is no .meta text', () => {
    expect(setInstalledInText('')).toBe('[General]\r\ninstalled=true\r\nuninstalled=false\r\n');
  });

  it('inserts both keys after an existing [General] header, preserving other lines', () => {
    const text = '[General]\r\ngameName=Fallout4\r\nmodid=12345\r\n';
    expect(setInstalledInText(text)).toBe(
      '[General]\r\ninstalled=true\r\nuninstalled=false\r\ngameName=Fallout4\r\nmodid=12345\r\n',
    );
  });

  it('flips an existing installed=false to true in place, byte-faithful', () => {
    const text = '[General]\r\ngameName=Fallout4\r\ninstalled=false\r\nmodid=12345\r\n';
    expect(setInstalledInText(text)).toBe(
      '[General]\r\nuninstalled=false\r\ngameName=Fallout4\r\ninstalled=true\r\nmodid=12345\r\n',
    );
  });

  it('is a no-op when both keys already read installed', () => {
    const text = '[General]\r\ninstalled=true\r\nuninstalled=false\r\nmodid=12345\r\n';
    expect(setInstalledInText(text)).toBe(text);
  });

  // MO2's markInstalled writes `uninstalled=false` beside `installed=true`, and a reader takes
  // `uninstalled` first — so a reinstall that left it true would read Uninstalled in MO2 itself.
  it('clears an earlier uninstall, so a reinstalled download reads Installed again', () => {
    const uninstalled = setUninstalledInText('[General]\r\ninstalled=true\r\n');
    expect(parseDownloadMeta(uninstalled).status).toBe('Uninstalled');
    expect(parseDownloadMeta(setInstalledInText(uninstalled)).status).toBe('Installed');
  });

  // MO2 (via Qt's QSettings) always writes CRLF on Windows, but mEdit is not
  // Windows-only — a .meta produced on a platform that writes bare LF must keep
  // its own convention rather than have CRLF forced onto it.
  it('preserves LF-only line endings when inserting after an existing [General] header', () => {
    const text = '[General]\ngameName=Fallout4\n';
    expect(setInstalledInText(text)).toBe('[General]\ninstalled=true\nuninstalled=false\ngameName=Fallout4\n');
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

describe('buildDownloadRows', () => {
  const entry = (name: string, mtimeMs: number, metaText?: string): DownloadEntry => ({
    name,
    size: 123,
    mtimeMs,
    metaText,
  });
  // Every row here is about the sidecar alone, so no mod claims any of them.
  const rowsFrom = (entries: DownloadEntry[]) => buildDownloadRows(entries, new Map());

  it('maps a plain archive with no .meta sidecar to a Downloaded row (gating off)', () => {
    const rows = rowsFrom([entry('foo.zip', 100)]);
    expect(rows).toEqual([
      {
        name: 'foo.zip',
        displayName: 'foo.zip',
        status: 'Downloaded',
        size: 123,
        mtimeMs: 100,
        hasMeta: false,
        excluded: false,
        modID: undefined,
      },
    ]);
  });

  it('flags hasMeta and carries modID for an archive with a .meta sidecar', () => {
    const rows = rowsFrom([entry('foo.zip', 100, '[General]\r\nmodID=12345\r\n')]);
    expect(rows[0]).toMatchObject({ name: 'foo.zip', hasMeta: true, modID: '12345' });
  });

  it('flags hasMeta true for a present-but-empty .meta (there is still a file to open)', () => {
    const rows = rowsFrom([entry('foo.zip', 100, '')]);
    expect(rows[0]).toMatchObject({ hasMeta: true, modID: undefined });
  });

  it('never turns a .meta file into its own row', () => {
    const rows = rowsFrom([
      entry('foo.zip', 100, '[General]\r\ninstalled=true\r\n'),
      entry('foo.zip.meta', 100),
    ]);
    expect(rows.map((r) => r.name)).toEqual(['foo.zip']);
  });

  // Entries are out of mtimeMs order on purpose: a two-element ascending fixture
  // would pass by coincidence even if nothing were re-sorted.
  it('defaults to Filetime (mtimeMs) descending', () => {
    const rows = rowsFrom([entry('b.zip', 2), entry('a.zip', 1), entry('c.zip', 3)]);
    expect(rows.map((r) => r.name)).toEqual(['c.zip', 'b.zip', 'a.zip']);
  });

  it('carries the excluded flag through without filtering (filtering is a view concern)', () => {
    const rows = rowsFrom([entry('foo.zip', 100, '[General]\r\nremoved=true\r\n')]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'foo.zip', excluded: true });
  });

  it('uses the .meta name as displayName when present', () => {
    const rows = rowsFrom([entry('foo_1_2_3.zip', 100, '[General]\r\nname=Sleep or Save\r\n')]);
    expect(present(rows[0], 'the sole row').displayName).toBe('Sleep or Save');
  });

  it('falls back to the filename for displayName when .meta has no name', () => {
    const rows = rowsFrom([entry('foo.zip', 100, '[General]\r\ninstalled=true\r\n')]);
    expect(present(rows[0], 'the sole row').displayName).toBe('foo.zip');
  });

  it('falls back to the filename for displayName when .meta name is present but empty', () => {
    const rows = rowsFrom([entry('foo.zip', 100, '[General]\r\nname=\r\n')]);
    expect(present(rows[0], 'the sole row').displayName).toBe('foo.zip');
  });

  it('produces a complete row (displayName = filename, version absent) when there is no .meta at all', () => {
    const rows = rowsFrom([entry('foo.zip', 100)]);
    const row = present(rows[0], 'the sole row');
    expect(row.displayName).toBe('foo.zip');
    expect(row.version).toBeUndefined();
  });

  it('carries version through from .meta', () => {
    const rows = rowsFrom([entry('foo.zip', 100, '[General]\r\nversion=1.2.3\r\n')]);
    expect(present(rows[0], 'the sole row').version).toBe('1.2.3');
  });

  it('carries fileID through from .meta', () => {
    const rows = rowsFrom([entry('foo.zip', 100, '[General]\r\nfileID=456\r\n')]);
    expect(present(rows[0], 'the sole row').fileID).toBe('456');
  });

  it('carries no fileID when the sidecar has none', () => {
    const rows = rowsFrom([entry('foo.zip', 100, '[General]\r\nmodID=12345\r\n')]);
    expect(present(rows[0], 'the sole row').fileID).toBeUndefined();
  });
});

// A download is installed when a mod says so, never when the sidecar says so: uninstall a mod
// outside Modbench and its `.meta` still claims `installed=true`.
describe('modsByInstallationFile — which mods each download was installed into', () => {
  it('keys a mod under the download its meta.ini names, case-folded', () => {
    expect(modsByInstallationFile([{ name: 'UFO4P', archiveFilename: 'UFO4P-4598.7z' }]))
      .toEqual(new Map([['ufo4p-4598.7z', ['UFO4P']]]));
  });

  // Many to many: one download installed into several mods, never forced to one.
  it('keys every mod naming the same download under it, in mod order', () => {
    expect(modsByInstallationFile([
      { name: 'Textures', archiveFilename: 'Pack.7z' },
      { name: 'Meshes', archiveFilename: 'pack.7z' },
    ])).toEqual(new Map([['pack.7z', ['Textures', 'Meshes']]]));
  });

  it('claims no download for a mod with no installation file: unknown, never an uninstall', () => {
    expect(modsByInstallationFile([{ name: 'Hand Made' }])).toEqual(new Map());
  });
});

describe('buildDownloadRows — Installed follows the mods, not the sidecar', () => {
  const entry = (name: string, metaText?: string): DownloadEntry => ({ name, size: 1, mtimeMs: 1, metaText });

  it('reads as Installed when a mod names it, whatever the sidecar says', () => {
    const rows = buildDownloadRows([entry('Pack.7z', '[General]\r\nmodID=1\r\n')], new Map([['pack.7z', ['Textures']]]));

    expect(present(rows[0], 'the sole row').status).toBe('Installed');
  });

  it('reads as Uninstalled, not Downloaded, when no mod names it though the sidecar claims installed', () => {
    const rows = buildDownloadRows([entry('Pack.7z', '[General]\r\ninstalled=true\r\n')], new Map());

    expect(present(rows[0], 'the sole row').status).toBe('Uninstalled');
  });

  // MO2's own Uninstalled is a user statement about the archive, not a claim about a mod.
  it('keeps the sidecar\u2019s Uninstalled when no mod names it', () => {
    const rows = buildDownloadRows([entry('Pack.7z', '[General]\r\nuninstalled=true\r\n')], new Map());

    expect(present(rows[0], 'the sole row').status).toBe('Uninstalled');
  });
});
