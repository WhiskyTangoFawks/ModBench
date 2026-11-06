import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { heldTexts, NO_FILE_CHANGES, type RenamePlan } from '../../symbolNames/symbolNames';
import { manifestEntryReferences } from '../manifestEntryReferences';

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

const owner = (sourceFolderOf: (mod: string) => string | undefined = () => sourceFolder) => manifestEntryReferences({
  modFolderOf: (mod) => Promise.resolve(mod === 'Old' ? modFolder : undefined),
  sourceFolderOf,
});

async function planned(text: string, sourceFolderOf?: (mod: string) => string | undefined, held = NONE): Promise<RenamePlan> {
  await writeFile(join(modFolder, 'Old.manifest.json'), text);
  const plan = await owner(sourceFolderOf).plan(MOD, 'New', held);
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

    const plan = await planned(LINKED, undefined, heldTexts([[join(modFolder, 'Old.manifest.json'), unsaved]]));

    expect(plan.changes.documents).toEqual([{ path: join(modFolder, 'New.manifest.json'), text: unsaved.replace('"name":"Old"', '"name":"New"') }]);
  });

  it('leaves the repository a manifest names when the mod has no source folder named for it, and moves its file', async () => {
    const plan = await planned(LINKED, () => undefined);

    expect(plan.changes.documents).toEqual([]);
    expect(plan.changes.moves).toEqual([{ from: join(modFolder, 'Old.manifest.json'), to: join(modFolder, 'New.manifest.json') }]);
  });

  it('leaves a manifest named otherwise where it is', async () => {
    await writeFile(join(modFolder, 'Other.manifest.json'), LINKED);

    expect(await owner(() => undefined).plan(MOD, 'New', NONE)).toMatchObject({ changes: NO_FILE_CHANGES, cannotFollow: [] });
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
