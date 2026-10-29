import { describe, it, expect } from 'vitest';
import { manifestText, readManifest } from '../manifestAdapter';
import type { Manifest } from '../manifestAdapter';

const mod7z = { kind: 'installationFile', name: 'Mod.7z', size: 100, hash: 'AAAA', page: 'https://www.nexusmods.com/fallout4/mods/1' } as const;

const modWithVersion = (
  '{\n'
  + '"packages": [\n{"installationFile":"Mod.7z","size":100,"hash":"AAAA","page":"https://www.nexusmods.com/fallout4/mods/1","version":"1.2.3"}\n],\n'
  + '"files": [\n'
  + '{"path":"a.nif"},\n'
  + '{"path":"b.nif","packagePath":"Data/b.nif"},\n'
  + '{"path":"y.esp","otherBytes":true},\n'
  + '{"path":"z.txt","inPackage":false}\n'
  + ']\n'
  + '}\n'
);

const withSteps = (
  '{\n'
  + '"packages": [\n{"installationFile":"Mod.7z","size":100,"hash":"AAAA","page":"https://www.nexusmods.com/fallout4/mods/1"}\n],\n'
  + '"steps": [\n{"task":"Optimise textures","args":["--in","textures"]},\n{"task":"Archive"}\n],\n'
  + '"tools": [\n{"task":"Optimise textures","page":"https://example.com/optimiser"},\n{"task":"Archive","page":"https://example.com/archive"}\n],\n'
  + '"files": [\n{"path":"a.nif"},\n{"path":"textures/a.dds","madeByStep":true}\n]\n}\n'
);

const sourceMod = (
  '{\n"output": "mod",\n"packages": [\n'
  + '{"submodule":"Mod"},\n'
  + '{"installationFile":"Zed.7z","size":7,"hash":"ZZZZ"},\n'
  + '{"installationFile":"Alpha.zip","size":5,"hash":"AAAA","page":"https://www.nexusmods.com/fallout4/mods/1"}\n'
  + '],\n'
  + '"files": [\n'
  + '{"path":"a.nif"},\n'
  + '{"path":"b.nif","package":"Zed.7z"},\n'
  + '{"path":"c.nif","package":"Alpha.zip","inPackage":false},\n'
  + '{"path":"d.nif","package":"Alpha.zip","otherBytes":true},\n'
  + '{"path":"e.nif","package":"Alpha.zip","packagePath":"meshes/e.nif"},\n'
  + '{"path":"f.nif"}\n'
  + ']\n'
  + '}\n'
);

const builtSourceMod = (
  '{\n'
  + '"output": "The Mod",\n'
  + '"packages": [\n{"submodule":"Mod","version":"1.0"}\n],\n'
  + '"exclude": ["a.esp","docs"],\n'
  + '"archives": {\n'
  + '"Mod - Main.ba2": ["meshes/a.nif","meshes/b.nif"],\n'
  + '"Mod - Textures.ba2": ["textures/a.dds"]\n'
  + '},\n'
  + '"files": [\n'
  + '{"path":"Mod - Main.ba2"},\n'
  + '{"path":"Mod.esp"}\n'
  + ']\n'
  + '}\n'
);

const sourceModWithoutFiles = '{\n"output": "Mod",\n"files": []\n}\n';

const gameFolder = (
  '{\n"packages": [\n{"gameFolder":"Fallout 4","hash":"AAAA","depots":{"377161":"11","377162":"22"},"version":"2"}\n],\n"files": []\n}\n'
);

const depotsOfUnequalLength = (
  '{\n"packages": [\n{"gameFolder":"Fallout 4","hash":"AAAA","depots":{"1234567":"22","377161":"11"}}\n],\n"files": []\n}\n'
);

const sourceModWithExclusionsAndArchives = (
  '{\n"output": "mod",\n"packages": [\n{"submodule":"Mod"}\n],\n'
  + '"exclude": ["a/b.txt","B.txt"],\n'
  + '"archives": {\n"mod.ba2": ["a.nif","b.nif"]\n},\n'
  + '"files": []\n}\n'
);

describe('a manifest the adapter reads and writes', () => {
  it.each([
    ['a version, and a file in each place', modWithVersion],
    ['steps, tools and a file a step makes', withSteps],
    ['a source mod with its packages', sourceMod],
    ['a built source mod with its exclusions and archives', builtSourceMod],
    ['a source mod naming no file', sourceModWithoutFiles],
    ['a game folder with its depots', gameFolder],
    ['depots whose ids differ in length, in ordinal order', depotsOfUnequalLength],
    ['exclusions and archives in a source mod', sourceModWithExclusionsAndArchives],
  ])('round-trips %s byte for byte', (_name, text) => {
    const read = readManifest(text);
    if (!('manifest' in read)) throw new Error(read.refused);
    expect(manifestText(read.manifest)).toBe(text);
  });

  it('reads the first package version as the manifest version, and a file naming no package as the first', () => {
    const read = readManifest(modWithVersion);
    if (!('manifest' in read)) throw new Error(read.refused);
    expect(read.manifest).toMatchObject({ version: '1.2.3', packages: [mod7z] });
    expect(read.manifest.files[0]).toEqual({ path: 'a.nif', entry: { kind: 'held' } });
  });

  it('writes its files in path order, ignoring case first', () => {
    const manifest: Manifest = {
      packages: [], exclude: [], archives: [], steps: [], tools: [],
      files: ['b.nif', 'B.nif', 'a.nif'].map((path) => ({ path, entry: { kind: 'held' } })),
    };
    expect(manifestText(manifest)).toBe('{\n"files": [\n{"path":"a.nif"},\n{"path":"B.nif"},\n{"path":"b.nif"}\n]\n}\n');
  });

  it('writes a file in the first package without naming it, and a file in another package naming it', () => {
    const second = { kind: 'installationFile', name: 'Zed.7z', size: 7, hash: 'ZZZZ' } as const;
    const manifest: Manifest = {
      packages: [mod7z, second], exclude: [], archives: [], steps: [], tools: [],
      files: [{ path: 'a.nif', entry: { kind: 'held' }, package: 'Mod.7z' }, { path: 'b.nif', entry: { kind: 'held' }, package: 'Zed.7z' }],
    };
    expect(manifestText(manifest)).toContain('"files": [\n{"path":"a.nif"},\n{"path":"b.nif","package":"Zed.7z"}\n]');
  });

  it('writes a manifest of no file as an empty files array', () => {
    expect(manifestText({ packages: [], exclude: [], archives: [], steps: [], tools: [], files: [] })).toBe('{\n"files": []\n}\n');
  });
});

describe('a manifest the adapter refuses', () => {
  it.each([
    ['<<<<<<< HEAD\n', 'line 1'],
    ['{\n"files": [\n{"path":"a.txt"}\n{"path":"b.txt"}\n]\n}\n', 'line 4'],
    ['{\n"files": [],\n<<<<<<< HEAD\n}\n', 'line 3'],
    ['line 5 {', 'line 1'],
    ['{"files": [{"path":"a.txt"},{"path":7}]}', 'its file 2'],
    ['{"files": [{"path":"a.txt"},{"path":"b.txt","packagePath":7}]}', 'its file 2'],
    ['{"files": [{"path":"a.txt","otherBytes":false}]}', 'its file 1: its otherBytes is false'],
    ['{"files": [{"path":"a.txt","inPackage":true}]}', 'its file 1: its inPackage is true'],
    ['{"files": [{"path":"a.txt","inPackage":false,"otherBytes":true}]}', 'its file 1: it says both'],
    ['{"files": [{"path":"a.txt","otherBytes":true,"packagePath":"b.txt"}]}', 'its file 1: it names a path'],
    ['{"files": [{"path":"a.txt","inPackage":false,"packagePath":"b.txt"}]}', 'its file 1: it names a path'],
    ['{"files": [{"path":"a.txt","package":"A.zip"}]}', 'its file 1: it names a package the manifest does not name'],
    ['{"packages": [{"installationFile":"A.zip","size":1,"hash":"H"}], "steps": [{"task":"Zip"}], "files": [{"path":"a.txt","package":"A.zip","madeByStep":true}]}', 'its file 1: it names a package for a file a step makes'],
    ['{"packages": [{"installationFile":"A.zip","size":1,"hash":"H"}, {"installationFile":"A.zip","size":2,"hash":"G"}], "files": []}', "names the package 'A.zip' twice"],
    ['{"packages": [{"submodule":"Mod"}, {"installationFile":"A.zip","size":1,"hash":"H","version":"2"}], "files": []}', "its manifest's package 2 holds a version"],
    ['{"packages": [{"installationFile":"A.zip"}], "files": []}', 'its manifest cannot be read at its package 1'],
    ['{"packages": [{"installationFile":"A.zip","size":1,"hash":"H","path":"C:/A.zip"}], "files": []}', "its manifest's package 1 holds 'path'"],
    ['{"files": []', 'line 1'],
    ['{"packages": [{"remote":"https://example.com/mod.git"}], "files": []}', "holds 'remote'"],
    ['{"packages": [{"version": 7}], "files": []}', 'cannot be read'],
    ['{}', 'cannot be read'],
    ['[]', 'cannot be read'],
    ['{"steps": [{"task":"Zip"}], "files": [{"path":"a.txt","madeByStep":false}]}', 'its file 1: its madeByStep is false'],
    ['{"steps": [{"task":"Zip"}], "files": [{"path":"a.txt","madeByStep":true,"otherBytes":true}]}', 'its file 1: it says both'],
    ['{"steps": [{"task":"Zip"}], "files": [{"path":"a.txt","madeByStep":true,"packagePath":"b.txt"}]}', 'its file 1: it names a path'],
    ['{"files": [{"path":"a.txt","madeByStep":true}]}', 'its file 1: it says a step makes the file, and the manifest holds no step'],
    ['{"steps": [{"task":""}], "files": []}', 'its manifest cannot be read at its step 1: it names no task'],
    ['{"steps": [{"args":["a"]}], "files": []}', 'its manifest cannot be read at its step 1'],
    ['{"steps": [{"task":"Zip","args":[1]}], "files": []}', 'its manifest cannot be read at its step 1'],
    ['{"tools": [{"page":"https://example.com"}], "files": []}', 'its manifest cannot be read at its tool 1'],
    ['{"tools": [{"task":"Zip"}], "files": []}', 'its manifest cannot be read at its tool 1'],
    ['{"tools": [{"task":"Zip","page":" "}], "files": []}', 'its manifest cannot be read at its tool 1: it names no page'],
    ['{"tools": [{"task":"","page":"https://example.com"}], "files": []}', 'its manifest cannot be read at its tool 1: it names no task'],
    ['{"tools": [{"task":"Zip","page":"https://example.com","path":"C:/zip.exe"}], "files": []}', "its manifest's tool 1 holds 'path', which Modbench does not read"],
    ['{"output": "a/b", "files": []}', 'is not a folder name'],
    ['{"exclude": ["../a"], "files": []}', "its manifest's 'exclude' names '../a', which is not a path in the folder"],
    ['{"archives": {"a.ba2": ["C:/x"]}, "files": []}', "its manifest's 'archives' names 'C:/x'"],
    ['{"extra": 1, "files": []}', "holds 'extra'"],
  ])('refuses %j naming where', (text, where) => {
    const read = readManifest(text);
    expect('refused' in read ? read.refused : '').toContain(where);
  });
});
