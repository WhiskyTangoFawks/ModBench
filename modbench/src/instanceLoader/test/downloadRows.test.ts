import { describe, it, expect } from 'vitest';
import type { DownloadedFile, DownloadMeta } from '../../instanceAdapter/instanceAdapter';
import { buildDownloadRows, modsByInstallationFile, type DownloadFile } from '../downloadRows';

const metaOf = (fields: Partial<DownloadMeta> = {}): DownloadMeta => ({ status: 'Downloaded', excluded: false, ...fields });

const file = (name: string, mtimeMs: number, meta?: DownloadMeta): DownloadedFile => ({
  name, path: `/downloads/${name}`, metaPath: `/downloads/${name}.meta`, size: 123, mtimeMs, meta,
});

// The one row a single file builds: any other count fails here, never as a read of undefined.
function soleRow(rows: readonly DownloadFile[]): DownloadFile {
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (row === undefined) throw new Error('no row was built');
  return row;
}

describe('buildDownloadRows', () => {
  // Every row here is about the metadata alone, so no mod claims any of them.
  const rowsFrom = (files: DownloadedFile[]) => buildDownloadRows(files, new Map());

  it('maps a file with no metadata to a Downloaded row carrying its two paths', () => {
    expect(rowsFrom([file('foo.zip', 100)])).toEqual([{
      name: 'foo.zip',
      displayName: 'foo.zip',
      status: 'Downloaded',
      size: 123,
      mtimeMs: 100,
      hasMeta: false,
      excluded: false,
      path: '/downloads/foo.zip',
      sidecarPath: '/downloads/foo.zip.meta',
    }]);
  });

  it('flags hasMeta and carries the metadata\'s fields', () => {
    const row = soleRow(rowsFrom([file('foo.zip', 100, metaOf({
      modID: '12345', fileID: '456', version: '1.2.3', modName: 'Sleep', gameName: 'Fallout4', author: 'Someone',
    }))]));

    expect(row).toMatchObject({
      hasMeta: true, modID: '12345', fileID: '456', version: '1.2.3', modName: 'Sleep', gameName: 'Fallout4', author: 'Someone',
    });
  });

  // Entries are out of mtimeMs order on purpose: a two-element ascending fixture
  // would pass by coincidence even if nothing were re-sorted.
  it('defaults to Filetime (mtimeMs) descending', () => {
    const rows = rowsFrom([file('b.zip', 2), file('a.zip', 1), file('c.zip', 3)]);
    expect(rows.map((r) => r.name)).toEqual(['c.zip', 'b.zip', 'a.zip']);
  });

  it('carries the excluded flag through without filtering (filtering is a view concern)', () => {
    const rows = rowsFrom([file('foo.zip', 100, metaOf({ excluded: true }))]);
    expect(soleRow(rows)).toMatchObject({ name: 'foo.zip', excluded: true });
  });

  it('uses the metadata\'s name as displayName when present', () => {
    expect(soleRow(rowsFrom([file('foo_1_2_3.zip', 100, metaOf({ name: 'Sleep or Save' }))])).displayName).toBe('Sleep or Save');
  });

  it('falls back to the filename for displayName when the metadata\'s name is absent or empty', () => {
    expect(soleRow(rowsFrom([file('foo.zip', 100, metaOf())])).displayName).toBe('foo.zip');
    expect(soleRow(rowsFrom([file('foo.zip', 100, metaOf({ name: '' }))])).displayName).toBe('foo.zip');
  });
});

// A download is installed when a mod says so, never when its metadata says so: uninstall a mod
// outside Modbench and its metadata still claims installed.
describe('modsByInstallationFile — which mods each download was installed into', () => {
  it('keys a mod under the download its meta names, case-folded', () => {
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

describe('buildDownloadRows — Installed follows the mods, not the metadata', () => {
  it('reads as Installed when a mod names it, whatever the metadata says', () => {
    const rows = buildDownloadRows([file('Pack.7z', 1, metaOf({ modID: '1' }))], new Map([['pack.7z', ['Textures']]]));

    expect(soleRow(rows).status).toBe('Installed');
  });

  it('reads as Uninstalled, not Downloaded, when no mod names it though the metadata claims installed', () => {
    const rows = buildDownloadRows([file('Pack.7z', 1, metaOf({ status: 'Installed' }))], new Map());

    expect(soleRow(rows).status).toBe('Uninstalled');
  });

  // MO2's own Uninstalled is a user statement about the archive, not a claim about a mod.
  it('keeps the metadata’s Uninstalled when no mod names it', () => {
    const rows = buildDownloadRows([file('Pack.7z', 1, metaOf({ status: 'Uninstalled' }))], new Map());

    expect(soleRow(rows).status).toBe('Uninstalled');
  });
});
