import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILD_FILE } from '../../wire/sourceMod';
import { buildFilePluginAt, buildFileReferences } from '../buildFileReferences';

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

const TEXT = '{"version":1,"steps":[\n{"decompile":["A.esp","B.esp"]},\n{"copy":["a/A.esp","A.esp"]},\n{"pack":{"A - Main.ba2":["A.esp"]}}\n]}\n';

const owner = () => buildFileReferences(() => new Map([['Mod A', folder]]));

describe('a build file names a plugin of its own mod in its steps (ADR-0028)', () => {
  it('answers each step that names the plugin at the root, in any case, with its mod', async () => {
    await writeFile(file, TEXT.replace('"A.esp","B', '"a.ESP","B'));

    const { references, leftOut } = await owner().read({ name: 'A.esp', origin: 'mod a' }, new Map());

    expect(leftOut).toEqual([]);
    expect(references).toEqual([
      { place: { file, start: { line: 1, character: 15 }, end: { line: 1, character: 20 } }, names: { name: 'a.ESP', origin: 'Mod A' } },
      { place: { file, start: { line: 2, character: 20 }, end: { line: 2, character: 25 } }, names: { name: 'A.esp', origin: 'Mod A' } },
    ]);
  });

  it('reads the build file\'s unsaved text in place of the file', async () => {
    await writeFile(file, TEXT);

    const { references } = await owner().read({ name: 'B.esp', origin: 'Mod A' }, new Map([[file, '{"version":1,"steps":[{"compile":["C.esp"]}]}']]));

    expect(references).toEqual([]);
  });

  it('names nothing for a plugin of a mod that is no source mod, or whose folder holds no build file', async () => {
    expect((await owner().read({ name: 'A.esp', origin: 'Mod B' }, new Map())).references).toEqual([]);
    expect(await owner().read({ name: 'A.esp', origin: 'Mod A' }, new Map())).toEqual({ references: [], leftOut: [] });
  });

  it('leaves out a build file it cannot read, saying why', async () => {
    await writeFile(file, '{"version":2}');

    expect(await owner().read({ name: 'A.esp', origin: 'Mod A' }, new Map())).toEqual({
      references: [], leftOut: [`${file}: its build file is version 2, and Modbench reads only version 1`],
    });
  });
});

describe('the plugin a build file names at a place in its text', () => {
  it('is the name under the place in a step that names plugins at the root, with its span', () => {
    const at = TEXT.indexOf('B.esp') + 2;

    expect(buildFilePluginAt(TEXT, at)).toEqual({ name: 'B.esp', start: TEXT.indexOf('B.esp'), end: TEXT.indexOf('B.esp') + 5 });
    expect(buildFilePluginAt(TEXT, TEXT.indexOf('a/A.esp') + 3)).toBeUndefined();
    expect(buildFilePluginAt(TEXT, TEXT.lastIndexOf('A.esp') + 1)).toBeUndefined();
  });
});
