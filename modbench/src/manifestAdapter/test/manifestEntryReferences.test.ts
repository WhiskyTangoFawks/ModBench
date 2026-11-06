import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { heldTexts, NO_FILE_CHANGES, type RenamePlan } from '../../symbolNames/symbolNames';
import { manifestDownloadedFileReferences, manifestEntryReferences, manifestEntryNames } from '../manifestEntryReferences';

let root: string;
let modFolder: string;
let sourceFolder: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'manifestEntryReferences-'));
  modFolder = join(root, 'mods', 'Old');
  sourceFolder = join(root, 'source', 'Old');
  await mkdir(modFolder, { recursive: true });
  await mkdir(sourceFolder, { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

const MOD = { kind: 'mod', name: 'Old' } as const;
const NONE = heldTexts([]);
const LINKED = '{\n"version":1,\n"packages":[\n{"kind":"repository","name":"Old"}\n],\n"files":{\n"Old.esp":"Qm9yZGVyczE="\n}\n}\n';

const owner = (withSourceFolder = true) => manifestEntryReferences({
  modFolderOf: (mod) => Promise.resolve(mod === 'Old' ? modFolder : undefined),
  sourceFolder: withSourceFolder ? sourceFolder : undefined,
});

async function planned(text: string, withSourceFolder = true, held = NONE): Promise<RenamePlan> {
  await writeFile(join(modFolder, 'Old.manifest.json'), text);
  const plan = await owner(withSourceFolder).plan(MOD, 'New', held);
  if ('refused' in plan) throw new Error(plan.refused);
  return plan;
}

describe('a mod\'s manifest names the mod: its file name, and the repository of its source folder (ADR-0028)', () => {
  it('moves the manifest named for the mod to the new name, its repository named for the moved source folder', async () => {
    const plan = await planned(LINKED);

    expect(plan.changes).toEqual({
      moves: [{ from: join(modFolder, 'Old.manifest.json'), to: join(modFolder, 'New.manifest.json') }],
      deletions: [],
      documents: [{ path: join(modFolder, 'New.manifest.json'), text: LINKED.replace('"name":"Old"', '"name":"New"') }],
    });
    expect(plan.cannotFollow).toEqual([]);
  });

  it('renames the manifest of the text the editor holds unsaved', async () => {
    const unsaved = LINKED.replace('"Old.esp":"Qm9yZGVyczE="', '"Old.esp":"2xdzlSxY/4k="');

    const plan = await planned(LINKED, true, heldTexts([[join(modFolder, 'Old.manifest.json'), unsaved]]));

    expect(plan.changes.documents).toEqual([{ path: join(modFolder, 'New.manifest.json'), text: unsaved.replace('"name":"Old"', '"name":"New"') }]);
  });

  it('leaves the repository a manifest names when the mod has no source folder named for it, and moves its file', async () => {
    const plan = await planned(LINKED, false);

    expect(plan.changes.documents).toEqual([]);
    expect(plan.changes.moves).toEqual([{ from: join(modFolder, 'Old.manifest.json'), to: join(modFolder, 'New.manifest.json') }]);
  });

  it('leaves a manifest named otherwise where it is', async () => {
    await writeFile(join(modFolder, 'Other.manifest.json'), LINKED);

    expect(await owner(false).plan(MOD, 'New', NONE)).toMatchObject({ changes: NO_FILE_CHANGES, cannotFollow: [] });
  });

  it('cannot follow a manifest it cannot read, saying why', async () => {
    const plan = await planned('{ not json');

    expect(plan.changes.documents).toEqual([]);
    expect(plan.cannotFollow).toEqual([expect.stringContaining(join(modFolder, 'Old.manifest.json'))]);
  });

  it('names the source folder\'s manifest named for the mod, which the source folder\'s move renames', async () => {
    await writeFile(join(sourceFolder, 'Old.manifest.json'), '{"version":1}\n');

    expect(await owner().sourceFilesOf(MOD, 'New')).toEqual([{ from: 'Old.manifest.json', to: 'New.manifest.json' }]);
  });

  it('owns nothing of a separator', async () => {
    expect(await owner().plan({ kind: 'separator', name: 'Old' }, 'New', NONE)).toMatchObject({ changes: NO_FILE_CHANGES, cannotFollow: [] });
  });
});

describe('where a mod\'s manifest names the mod (ADR-0028)', () => {
  const names = (folder = modFolder) => manifestEntryNames({
    modFolderOf: (mod) => Promise.resolve(mod === 'Old' ? folder : undefined),
    modFolders: () => new Map([['Old', folder]]),
  });
  const file = () => join(modFolder, 'Old.manifest.json');

  it('names it at its own manifest\'s repository package named for it, whatever the case, and for no other name', async () => {
    await writeFile(file(), LINKED.replace('"name":"Old"', '"name":"old"'));

    const { references, leftOut } = await names().read(MOD, NONE);

    expect(leftOut).toEqual([]);
    expect((await names().read({ kind: 'mod', name: 'Other' }, NONE)).references).toEqual([]);
    expect((await names().read({ kind: 'separator', name: 'Old' }, NONE)).references).toEqual([]);
    expect(references).toEqual([{ file: file(), start: { line: 3, character: 29 }, end: { line: 3, character: 32 } }]);
  });

  it('reads the text the editor holds unsaved in place of the file', async () => {
    await writeFile(file(), '{"version":1}');

    const { references } = await names().read(MOD, heldTexts([[file(), LINKED]]));

    expect(references).toEqual([{ file: file(), start: { line: 3, character: 29 }, end: { line: 3, character: 32 } }]);
  });

  it('says why a manifest it cannot read is left out', async () => {
    await writeFile(file(), '{ not json');

    const { references, leftOut } = await names().read(MOD, NONE);

    expect([references, leftOut]).toEqual([[], [expect.stringContaining(file()) as unknown]]);
  });

  it('says which mod a package of a mod\'s manifest names at a place, by the folder the instance lists the mod in, whatever the folder is called', async () => {
    const renamed = join(root, 'mods', 'Folder named otherwise');
    await mkdir(renamed, { recursive: true });
    const inRenamed = join(renamed, 'Old.manifest.json');
    await writeFile(inRenamed, LINKED);
    const start = LINKED.indexOf('"Old"}') + 1;

    expect(await names(renamed).nameAt(inRenamed, LINKED, start + 1)).toEqual({ entry: MOD, start, end: start + 3 });
  });

  it.each([
    ['a string of the manifest that is no package name', () => modFolder, LINKED.indexOf('Old.esp')],
    ['a manifest in a folder the instance lists the mod elsewhere than', () => join(root, 'mods', 'Elsewhere'), LINKED.indexOf('"Old"}') + 2],
  ])('says no mod is named at %s', async (_case, listedIn, offset) => {
    await writeFile(file(), LINKED);

    expect(await names(listedIn()).nameAt(file(), LINKED, offset)).toBeUndefined();
  });
});

describe('where a mod\'s manifest names a downloaded file: each installation file package (ADR-0028)', () => {
  const INSTALLED = '{\n"version":1,\n"packages":[\n{"kind":"installationFile","name":"Old-1.7z","size":1,"hash":"AAAAAAAAAAA="}\n],\n"files":{\n"Old.esp":"Qm9yZGVyczE="\n}\n}\n';
  const DOWNLOADED = { kind: 'downloadedFile', name: 'old-1.7z' } as const;
  const otherFolder = () => join(root, 'mods', 'Other');
  const names = () => manifestEntryNames({ modFolderOf: () => Promise.resolve(undefined), modFolders: () => new Map([['Old', modFolder], ['Other', otherFolder()]]) });
  const file = () => join(modFolder, 'Old.manifest.json');
  const place = { start: { line: 3, character: 35 }, end: { line: 3, character: 43 } };

  beforeEach(async () => {
    await writeFile(file(), INSTALLED);
    await mkdir(otherFolder());
    await writeFile(join(otherFolder(), 'Other.manifest.json'), INSTALLED.replace('Old-1.7z', 'Other-1.7z'));
  });

  it('names a downloaded file, whatever the case, at each manifest\'s installation file package of its name', async () => {
    expect(await names().read(DOWNLOADED, NONE)).toEqual({ references: [{ file: file(), ...place }], leftOut: [] });
  });

  it('places every downloaded file a manifest names', async () => {
    expect((await names().listed('downloadedFile', NONE)).map(({ entry }) => entry.name)).toEqual(['Old-1.7z', 'Other-1.7z']);
    expect(await names().listed('mod', NONE)).toEqual([]);
  });

  it('says why a manifest it cannot read is left out', async () => {
    await writeFile(file(), '{ not json');

    expect((await names().read(DOWNLOADED, NONE)).leftOut).toEqual([expect.stringContaining(file()) as unknown]);
  });

  it('says which downloaded file a package names at a place', async () => {
    const start = INSTALLED.indexOf('Old-1.7z');

    expect(await names().nameAt(file(), INSTALLED, start + 1)).toEqual({ entry: { kind: 'downloadedFile', name: 'Old-1.7z' }, start, end: start + 8 });
  });

  it('renames each package of the downloaded file\'s name, in the text the editor holds unsaved', async () => {
    const unsaved = INSTALLED.replace('"Old.esp"', '"Held.esp"');

    const plan = await manifestDownloadedFileReferences([modFolder, otherFolder()]).plan(DOWNLOADED, 'New "1".7z', heldTexts([[file(), unsaved]]));

    expect(plan).toMatchObject({
      changes: { moves: [], deletions: [], documents: [{ path: file(), text: unsaved.replace('Old-1.7z', 'New \\"1\\".7z') }] }, cannotFollow: [],
    });
  });

  it('writes the renamed manifest in canonical text, its installation files in order by name', async () => {
    const second = '{"kind":"installationFile","name":"Patch-1.7z","size":2,"hash":"BBBBBBBBBBA="}';
    const two = INSTALLED.replace('"hash":"AAAAAAAAAAA="}\n', `"hash":"AAAAAAAAAAA="},\n${second}\n`);
    await writeFile(file(), two);

    const plan = await manifestDownloadedFileReferences([modFolder]).plan(DOWNLOADED, 'Zed-1.7z', NONE);

    const first = '{"kind":"installationFile","name":"Zed-1.7z","size":1,"hash":"AAAAAAAAAAA="}';
    expect(plan).toMatchObject({ changes: { documents: [{ path: file(), text: INSTALLED.replace(/\{"kind".*\}\n\]/, `${second},\n${first}\n]`) }] } });
  });

  it('cannot follow a manifest it cannot read, saying why', async () => {
    await writeFile(file(), '{ not json');

    const plan = await manifestDownloadedFileReferences([modFolder]).plan(DOWNLOADED, 'New.7z', NONE);

    expect(plan).toMatchObject({ changes: NO_FILE_CHANGES, cannotFollow: [expect.stringContaining(file()) as unknown] });
  });
});

