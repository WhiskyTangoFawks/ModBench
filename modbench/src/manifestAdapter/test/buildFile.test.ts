import { describe, it, expect } from 'vitest';
import { buildFileText } from '../buildFileText';
import { readBuildFile } from '../buildFileRead';

const withSteps = (
  '{\n'
  + '"packages": [\n{"installationFile":"Mod.7z","size":100,"hash":"AAAA","page":"https://www.nexusmods.com/fallout4/mods/1"}\n],\n'
  + '"steps": [\n{"task":"Optimise textures","args":["--in","textures"]},\n{"task":"Archive"}\n],\n'
  + '"tools": [\n{"task":"Optimise textures","page":"https://example.com/optimiser"},\n{"task":"Archive","page":"https://example.com/archive"}\n],\n'
  + '"files": [\n{"path":"a.nif"},\n{"path":"textures/a.dds","madeByStep":true}\n]\n}\n'
);

const takingFromPackages = (
  '{\n"packages": [\n'
  + '{"installationFile":"Zed.7z","size":7,"hash":"ZZZZ"},\n'
  + '{"gameFolder":"Fallout 4","hash":"AAAA","depots":{"1234567":"22","377161":"11"}}\n'
  + '],\n'
  + '"archives": {\n"mod.ba2": ["a.nif","b.nif"]\n},\n'
  + '"files": [\n'
  + '{"path":"a.nif"},\n'
  + '{"path":"b.nif","package":"Fallout 4","packagePath":"meshes/b.nif"}\n'
  + ']\n'
  + '}\n'
);

describe('a build file the adapter reads and refuses', () => {
  it.each([
    ['its steps and tools', withSteps],
    ['its packages, archives and the files it takes', takingFromPackages],
  ])('round-trips %s byte for byte', (_name, text) => {
    const read = readBuildFile(text);
    if (!('buildFile' in read)) throw new Error(read.refused);
    expect(buildFileText(read.buildFile)).toBe(text);
  });

  it.each([
    ['{"packages": [{"installationFile":"A.zip","size":1,"hash":"H"}], "steps": [{"task":"Zip"}], "files": [{"path":"a.txt","package":"A.zip","madeByStep":true}]}', 'its file 1: it names a package for a file a step makes'],
    ['{"steps": [{"task":"Zip"}], "files": [{"path":"a.txt","madeByStep":false}]}', 'its file 1: its madeByStep is false'],
    ['{"steps": [{"task":"Zip"}], "files": [{"path":"a.txt","madeByStep":true,"otherBytes":true}]}', 'its file 1: it says both'],
    ['{"steps": [{"task":"Zip"}], "files": [{"path":"a.txt","madeByStep":true,"packagePath":"b.txt"}]}', 'its file 1: it names a path'],
    ['{"files": [{"path":"a.txt","madeByStep":true}]}', 'its file 1: it says a step makes the file, and the build file holds no step'],
    ['{"files": [{"path":"a.txt","package":"A.zip"}]}', 'its file 1: it names a package the build file does not name'],
    ['{"packages": [{"installationFile":"A.zip","size":1,"hash":"H"}, {"installationFile":"A.zip","size":2,"hash":"G"}], "files": []}', "names the package 'A.zip' twice"],
    ['{"archives": {"a.ba2": ["C:/x"]}, "files": []}', "its build file's 'archives' names 'C:/x'"],
    ['{"exclude": [], "files": []}', "its build file holds 'exclude', which Modbench does not read"],
    ['{"tools": [{"page":"https://example.com"}], "files": []}', 'its build file cannot be read at its tool 1'],
    ['{"tools": [{"task":"Zip","page":" "}], "files": []}', 'its build file cannot be read at its tool 1: it names no page'],
    ['{"tools": [{"task":"Zip","page":"https://example.com","path":"C:/zip.exe"}], "files": []}', "its build file's tool 1 holds 'path', which Modbench does not read"],
    ['{"steps": [{"task":""}], "files": []}', 'its build file cannot be read at its step 1: it names no task'],
    ['{"steps": [{"task":"Zip","args":[1]}], "files": []}', 'its build file cannot be read at its step 1'],
    ['{"files": [\n{"path":"a.txt"}\n{"path":"b.txt"}\n]}', 'line 3'],
  ])('refuses %j naming where', (text, where) => {
    const read = readBuildFile(text);
    expect('refused' in read ? read.refused : '').toContain(where);
  });
});
