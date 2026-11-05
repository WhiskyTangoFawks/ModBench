import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { heldTexts } from '../../symbolNames/symbolNames';
import { BUILD_FILE } from '../../wire/sourceMod';
import { buildFileReferences } from '../buildFileReferences';

let root: string;
let folder: string;
let file: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'buildFileReferences-'));
  folder = join(root, 'Mod A');
  file = join(folder, BUILD_FILE);
  await mkdir(folder);
});
afterEach(() => rm(root, { recursive: true, force: true }));

const TEXT = '{"version":1,"steps":[\n{"decompile":["A.esp","B.esp"]},\n{"copy":["a/A.esp","A.esp"]},\n{"unpack":{"In.7z":["A.esp"]}},\n{"pack":{"A - Main.ba2":["A.esp"]}}\n]}\n';
const NONE = heldTexts([]);

const owner = () => buildFileReferences(() => new Map([['Mod A', folder]]));
const at = (line: number, character: number) => ({ file, start: { line, character }, end: { line, character: character + 5 } });

describe('a build file names a plugin of its own mod in its steps (ADR-0028)', () => {
  it('answers each decompile, compile, copy and unpack step that names the plugin at the root, with its mod', async () => {
    await writeFile(file, TEXT);

    const { references, leftOut } = await owner().read({ name: 'A.esp', origin: 'Mod A' }, NONE);

    expect(leftOut).toEqual([]);
    expect(references).toEqual([at(1, 15), at(2, 20), at(3, 21)].map((place) => ({ place, names: { name: 'A.esp', origin: 'Mod A' } })));
  });

  it('reads the build file\'s unsaved text in place of the file', async () => {
    await writeFile(file, TEXT);

    const { references } = await owner().read({ name: 'B.esp', origin: 'Mod A' }, heldTexts([[file, '{"version":1,"steps":[{"compile":["B.esp"]}]}']]));

    expect(references).toEqual([{ place: { file, start: { line: 0, character: 35 }, end: { line: 0, character: 40 } }, names: { name: 'B.esp', origin: 'Mod A' } }]);
  });

  it('names nothing for a plugin of a mod that is no source mod, or whose folder holds no build file', async () => {
    expect((await owner().read({ name: 'A.esp', origin: 'Mod B' }, NONE)).references).toEqual([]);
    expect(await owner().read({ name: 'A.esp', origin: 'Mod A' }, NONE)).toEqual({ references: [], leftOut: [] });
  });

  it('leaves out a build file it cannot read, saying why', async () => {
    await writeFile(file, '{"version":2}');

    expect(await owner().read({ name: 'A.esp', origin: 'Mod A' }, NONE)).toEqual({
      references: [], leftOut: [`${file}: its build file is version 2, and Modbench reads only version 1`],
    });
  });
});

describe('the plugin a build file names at a place in its text', () => {
  it('is the name under the place in a step that names plugins at the root, with its mod', async () => {
    expect(await owner().nameAt(file, TEXT, TEXT.indexOf('B.esp') + 2)).toEqual({ name: 'B.esp', origin: 'Mod A' });
    expect(await owner().nameAt(file, TEXT, TEXT.indexOf('a/A.esp') + 3)).toBeUndefined();
    expect(await owner().nameAt(file, TEXT, TEXT.lastIndexOf('A.esp') + 1)).toBeUndefined();
  });

  it('is read in a build file the source folder spells in another case, and in no other file', async () => {
    expect(await owner().nameAt(join(folder, BUILD_FILE.toUpperCase()), TEXT, TEXT.indexOf('B.esp'))).toEqual({ name: 'B.esp', origin: 'Mod A' });
    expect(await owner().nameAt(join(root, 'Mod B', BUILD_FILE), TEXT, TEXT.indexOf('B.esp'))).toBeUndefined();
  });
});
