import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FolderValue } from '../../repositoriesLib/statusValues';
import { flagVariantsApplied, type FlagVariantsOf } from '../flaggedFolder';
import { folderAgainst } from '../modStatus';

const PACKAGE_COPY = 'AAAAAAAAAAA=';
const FLAGGED = 'BBBBBBBBBBA=';
const ROOT = join('mods', 'Mod');

const folderOf = (hash: string, pathInFolder = 'real/Mod.esp', own = 'real/Mod.esp'): FolderValue =>
  ({ files: new Map([[pathInFolder, { path: own, excluded: false, read: { kind: 'read', answer: { hash } } }]]), exclude: [], ignoresCase: false });

const manifest = { flags: new Map([['real/Mod.esp', { Small: true }]]), files: new Map([['real/Mod.esp', PACKAGE_COPY]]), exclude: [], ignore: [] };

const variants = (answer: Record<string, { flags: Record<string, boolean>; hash: string }[]>): FlagVariantsOf =>
  (paths) => Promise.resolve(new Map(paths.map((path) => [path, answer[path] ?? []])));

const holds = (folder: FolderValue): boolean | undefined => folderAgainst(manifest, folder).files[0]?.holdsItsBytes;

describe('a folder against the flags its manifest sets', () => {
  it('holds the bytes of a flagged plugin that is the package copy once the flags are cleared back', async () => {
    const asked: string[][] = [];
    const reader: FlagVariantsOf = (paths) => { asked.push([...paths]); return variants({ [join(ROOT, 'real/Mod.esp')]: [{ flags: { Small: false }, hash: PACKAGE_COPY }] })(paths); };

    const folder = await flagVariantsApplied(manifest, ROOT, folderOf(FLAGGED), reader);

    expect([holds(folder), asked]).toEqual([true, [[join(ROOT, 'real/Mod.esp')]]]);
  });

  it('differs when the plugin does not carry the flags, even when its bytes are the package copy', async () => {
    const reader = variants({ [join(ROOT, 'real/Mod.esp')]: [{ flags: { Small: true }, hash: FLAGGED }] });

    const folder = await flagVariantsApplied(manifest, ROOT, folderOf(PACKAGE_COPY), reader);

    expect(holds(folder)).toBe(false);
  });

  it('finds an excluded plugin by the path the folder holds it at', async () => {
    const reader = variants({ [join(ROOT, 'real/Mod.esp.mohidden')]: [{ flags: { Small: false }, hash: PACKAGE_COPY }] });

    const folder = await flagVariantsApplied(manifest, ROOT, folderOf(FLAGGED, 'real/Mod.esp.mohidden'), reader);

    expect(holds(folder)).toBe(true);
  });

  it('asks nothing of a manifest that sets no flags', async () => {
    const folder = folderOf(PACKAGE_COPY);

    const read = await flagVariantsApplied({ ...manifest, flags: new Map() }, ROOT, folder, () => Promise.reject(new Error('asked')));

    expect(read).toBe(folder);
  });
});
