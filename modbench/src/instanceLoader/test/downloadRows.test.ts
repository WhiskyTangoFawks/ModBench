import { describe, it, expect } from 'vitest';
import type { DownloadedFile, DownloadMeta } from '../../instanceAdapter/instanceAdapter';
import { buildDownloadRows, modsByArchiveFilename, type DownloadFile } from '../downloadRows';

const metaOf = (fields: Partial<DownloadMeta> = {}): DownloadMeta => ({ status: 'Downloaded', excluded: false, ...fields });

const file = (name: string, mtimeMs: number, meta?: DownloadMeta): DownloadedFile => ({
  name, path: `/downloads/${name}`, metaPath: `/downloads/${name}.meta`, size: 123, mtimeMs, meta,
});

function soleRow(rows: readonly DownloadFile[]): DownloadFile {
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (row === undefined) throw new Error('no row was built');
  return row;
}

describe('buildDownloadRows', () => {
  const rowsClaimedByNoMod = (files: DownloadedFile[]) => buildDownloadRows(files, new Map(), []);

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
      sidecarPath: '/downloads/foo.zip.meta',
    }]);
  });

  it('flags hasMeta and carries the metadata\'s fields', () => {
    const row = soleRow(rowsClaimedByNoMod([file('foo.zip', 100, metaOf({
      modID: '12345', fileID: '456', version: '1.2.3', modName: 'Sleep', gameName: 'Fallout4', author: 'Someone',
    }))]));

    expect(row).toMatchObject({
      hasMeta: true, modID: '12345', fileID: '456', version: '1.2.3', modName: 'Sleep', gameName: 'Fallout4', author: 'Someone',
    });
  });

  it('carries the excluded flag through without filtering (filtering is a view concern)', () => {
    const rows = rowsClaimedByNoMod([file('foo.zip', 100, metaOf({ excluded: true }))]);
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

describe('buildDownloadRows — the mods a file can upgrade', () => {
  it('carries the installed mods sharing the file\'s Nexus mod id, best match first', () => {
    const mods = [
      { kind: 'mod' as const, enabled: true, name: 'Other', nexusId: '1', version: '1.0' },
      { kind: 'mod' as const, enabled: true, name: 'Match', nexusId: '1', version: '2.0', installedFiles: [{ nexusId: '1', fileId: '9' }] },
    ];

    const row = soleRow(buildDownloadRows([file('Pack.7z', 1, metaOf({ modID: '1', fileID: '9' }))], new Map(), mods));

    expect(row.upgrades).toEqual([
      { modName: 'Match', version: '2.0', tier: 'fileId' },
      { modName: 'Other', version: '1.0', tier: undefined },
    ]);
  });
});

describe('modsByArchiveFilename — which mods each download was installed into', () => {
  it('keys a mod under the download its meta names, case-folded', () => {
    expect(modsByArchiveFilename([{ name: 'UFO4P', archiveFilename: 'UFO4P-4598.7z' }]))
      .toEqual(new Map([['ufo4p-4598.7z', ['UFO4P']]]));
  });

  it('keys every mod naming the same download under it, in mod order, a download installed into several mods never being forced to one', () => {
    expect(modsByArchiveFilename([
      { name: 'Textures', archiveFilename: 'Pack.7z' },
      { name: 'Meshes', archiveFilename: 'pack.7z' },
    ])).toEqual(new Map([['pack.7z', ['Textures', 'Meshes']]]));
  });

  it('claims no download for a mod with no archive filename: unknown, never an uninstall', () => {
    expect(modsByArchiveFilename([{ name: 'Hand Made' }])).toEqual(new Map());
  });
});

describe('buildDownloadRows — Installed follows the mods, not the metadata', () => {
  it('reads as Installed when a mod names it, whatever the metadata says', () => {
    const rows = buildDownloadRows([file('Pack.7z', 1, metaOf({ modID: '1' }))], new Map([['pack.7z', ['Textures']]]), []);

    expect(soleRow(rows).status).toBe('Installed');
  });

  it('reads as Uninstalled, not Downloaded, when no mod names it though the metadata claims installed', () => {
    const rows = buildDownloadRows([file('Pack.7z', 1, metaOf({ status: 'Installed' }))], new Map(), []);

    expect(soleRow(rows).status).toBe('Uninstalled');
  });

  it('keeps the metadata’s Uninstalled when no mod names it, MO2\'s own Uninstalled being a user statement about the archive, not a claim about a mod', () => {
    const rows = buildDownloadRows([file('Pack.7z', 1, metaOf({ status: 'Uninstalled' }))], new Map(), []);

    expect(soleRow(rows).status).toBe('Uninstalled');
  });
});
