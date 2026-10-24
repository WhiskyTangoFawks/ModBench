import { describe, it, expect } from 'vitest';
import type { DownloadedFile, DownloadedFileMeta } from '../../instanceAdapter/instanceAdapter';
import { buildDownloadedFileRows, modsByInstallationFileName, type LocatedDownloadedFileRow } from '../downloadedFileRows';

const metaOf = (fields: Partial<DownloadedFileMeta> = {}): DownloadedFileMeta => ({ status: 'Downloaded', ...fields });

const file = (name: string, mtimeMs: number, meta?: DownloadedFileMeta, excluded = false): DownloadedFile => ({
  name, path: `/downloads/${name}`, metadataPath: `/downloads/${name}.meta`, size: 123, mtimeMs, excluded, meta,
});

function soleRow(rows: readonly LocatedDownloadedFileRow[]): LocatedDownloadedFileRow {
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (row === undefined) throw new Error('no row was built');
  return row;
}

describe('the rows of the downloaded files', () => {
  const rowsClaimedByNoMod = (files: DownloadedFile[]) => buildDownloadedFileRows(files, new Map(), []);

  it('maps a file with no metadata to a Downloaded row carrying its two paths', () => {
    expect(rowsClaimedByNoMod([file('foo.zip', 100)])).toEqual([{
      name: 'foo.zip',
      displayName: 'foo.zip',
      status: 'Downloaded',
      size: 123,
      mtimeMs: 100,
      hasMeta: false,
      excluded: false,
      upgrades: [],
      path: '/downloads/foo.zip',
      metadataPath: '/downloads/foo.zip.meta',
    }]);
  });

  it('flags hasMeta and carries the metadata\'s fields', () => {
    const row = soleRow(rowsClaimedByNoMod([file('foo.zip', 100, metaOf({
      modID: '12345', version: '1.2.3', modName: 'Sleep', gameName: 'Fallout4', author: 'Someone',
    }))]));

    expect(row).toMatchObject({
      hasMeta: true, modID: '12345', version: '1.2.3', modName: 'Sleep', gameName: 'Fallout4', author: 'Someone',
    });
  });

  it('carries the excluded flag through without filtering (filtering is a view concern)', () => {
    const rows = rowsClaimedByNoMod([file('foo.zip', 100, undefined, true)]);
    expect(soleRow(rows)).toMatchObject({ name: 'foo.zip', excluded: true });
  });

  it('uses the metadata\'s name as displayName when present', () => {
    expect(soleRow(rowsClaimedByNoMod([file('foo_1_2_3.zip', 100, metaOf({ name: 'Sleep or Save' }))])).displayName).toBe('Sleep or Save');
  });

  it('falls back to the filename for displayName when the metadata\'s name is absent or empty', () => {
    expect(soleRow(rowsClaimedByNoMod([file('foo.zip', 100, metaOf())])).displayName).toBe('foo.zip');
    expect(soleRow(rowsClaimedByNoMod([file('foo.zip', 100, metaOf({ name: '' }))])).displayName).toBe('foo.zip');
  });
});

describe('which mods each downloaded file was installed into', () => {
  it('keys a mod under the downloaded file its meta names, case-folded', () => {
    expect(modsByInstallationFileName([{ name: 'UFO4P', installationFileName: 'UFO4P-4598.7z' }]))
      .toEqual(new Map([['ufo4p-4598.7z', ['UFO4P']]]));
  });

  it('keys every mod naming the same downloaded file under it, in mod order, a downloaded file installed into several mods never being forced to one', () => {
    expect(modsByInstallationFileName([
      { name: 'Textures', installationFileName: 'Pack.7z' },
      { name: 'Meshes', installationFileName: 'pack.7z' },
    ])).toEqual(new Map([['pack.7z', ['Textures', 'Meshes']]]));
  });

  it('claims no downloaded file for a mod with no installation file name: unknown, never an uninstall', () => {
    expect(modsByInstallationFileName([{ name: 'Hand Made' }])).toEqual(new Map());
  });
});

describe('a downloaded file\'s Installed follows the mods, not the metadata', () => {
  it('reads as Installed when a mod names it, whatever the metadata says', () => {
    const rows = buildDownloadedFileRows([file('Pack.7z', 1, metaOf({ modID: '1' }))], new Map([['pack.7z', ['Textures']]]), []);

    expect(soleRow(rows).status).toBe('Installed');
  });

  it('reads as Uninstalled, not Downloaded, when no mod names it though the metadata claims installed', () => {
    const rows = buildDownloadedFileRows([file('Pack.7z', 1, metaOf({ status: 'Installed' }))], new Map(), []);

    expect(soleRow(rows).status).toBe('Uninstalled');
  });

  it('keeps the metadata’s Uninstalled when no mod names it, MO2\'s own Uninstalled being a user statement about the downloaded file, not a claim about a mod', () => {
    const rows = buildDownloadedFileRows([file('Pack.7z', 1, metaOf({ status: 'Uninstalled' }))], new Map(), []);

    expect(soleRow(rows).status).toBe('Uninstalled');
  });
});
