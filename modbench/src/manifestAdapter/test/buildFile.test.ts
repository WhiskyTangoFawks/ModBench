import { describe, it, expect } from 'vitest';
import { buildFileText, type BuildFile } from '../buildFile';
import { readBuildFile } from '../buildFileRead';

const read = (text: string): ReturnType<typeof readBuildFile> => readBuildFile(text);

describe('a build file the adapter reads and refuses', () => {
  it('reads each step in order: each built-in step with its paths, each archive with the files it packs, and each task with the page of its tool', () => {
    const text = JSON.stringify({
      version: 1,
      steps: [
        { decompile: ['A.esp'] }, { compile: ['A.esp'] }, { copy: ['textures', 'readme.txt'] },
        { task: 'Optimise textures', args: ['--in', 'textures'], page: 'https://example.com/optimiser' }, { task: 'Archive' },
        { pack: { 'mod.ba2': ['a.nif', 'b.nif'] } },
      ],
    });

    expect(read(text)).toEqual({
      buildFile: {
        steps: [
          { kind: 'decompile', paths: ['A.esp'] }, { kind: 'compile', paths: ['A.esp'] }, { kind: 'copy', paths: ['textures', 'readme.txt'] },
          { kind: 'task', task: 'Optimise textures', args: ['--in', 'textures'], page: 'https://example.com/optimiser' }, { kind: 'task', task: 'Archive', args: [] },
          { kind: 'pack', archives: [{ path: 'mod.ba2', files: ['a.nif', 'b.nif'] }] },
        ],
      },
    });
  });

  it('reads archives of one pack step that pack different paths, a file that shares the name of an archive, and one path packed by two pack steps', () => {
    expect(read('{"version":1,"steps":[{"pack":{"a.ba2":["x.nif"],"b.ba2":["y.nif","a.ba2"]}},{"pack":{"c.ba2":["x.nif"]}}]}')).toEqual({
      buildFile: {
        steps: [
          { kind: 'pack', archives: [{ path: 'a.ba2', files: ['x.nif'] }, { path: 'b.ba2', files: ['y.nif', 'a.ba2'] }] },
          { kind: 'pack', archives: [{ path: 'c.ba2', files: ['x.nif'] }] },
        ],
      },
    });
  });

  it('reads a script step by its path in the source folder and a default script step by its name, each with its arguments', () => {
    expect(read('{"version":1,"steps":[{"script":"scripts/fix.py","args":["A.esp"]},{"defaultScript":"clean","args":["B.esp"]},{"script":"x.py"},{"defaultScript":"clean"}]}')).toEqual({
      buildFile: {
        steps: [
          { kind: 'script', script: 'scripts/fix.py', args: ['A.esp'] }, { kind: 'defaultScript', name: 'clean', args: ['B.esp'] },
          { kind: 'script', script: 'x.py', args: [] }, { kind: 'defaultScript', name: 'clean', args: [] },
        ],
      },
    });
  });

  it('reads a build file that holds only its version', () => {
    expect(read('{"version":1}')).toEqual({ buildFile: { steps: [] } });
  });

  it('reads back the text it writes', () => {
    const buildFile: BuildFile = {
      steps: [{ kind: 'copy', paths: ['textures', 'a.ini'] }, { kind: 'compile', paths: ['A.esp'] }, { kind: 'pack', archives: [{ path: 'a.ba2', files: ['x.nif'] }] }, { kind: 'task', task: 'T', args: ['x'] },
        { kind: 'script', script: 'fix.py', args: ['A.esp'] }, { kind: 'defaultScript', name: 'clean', args: [] }],
    };

    expect(read(buildFileText(buildFile))).toEqual({ buildFile });
  });

  it.each([
    ['{"steps": []}', 'its build file is in a format before version 1, and Modbench reads only version 1'],
    ['{"packages": [], "files": []}', 'its build file is in a format before version 1, and Modbench reads only version 1'],
    ['{"version":2}', 'its build file is version 2, and Modbench reads only version 1'],
    ['{"version":"1"}', 'its build file is version "1", and Modbench reads only version 1'],
    ['{"version":1,"tools":[]}', "its build file holds 'tools', which Modbench does not read"],
    ['{"version":1,"archives":{"a.ba2":["x.nif"]}}', "its build file holds 'archives', which Modbench does not read"],
    ['{"version":1,"exclude":[]}', "its build file holds 'exclude', which Modbench does not read"],
    ['{"version":1,"steps":[{"copy":["a"]},{}]}', 'its build file cannot be read at its step 2: it names no step'],
    ['{"version":1,"steps":[{"script":"../clean.py"}]}', "its build file's step 1 names '../clean.py', which is not a path in the folder"],
    ['{"version":1,"steps":[{"script":7}]}', 'its build file cannot be read at its step 1'],
    ['{"version":1,"steps":[{"defaultScript":""}]}', 'its build file cannot be read at its step 1: it names no default script'],
    ['{"version":1,"steps":[{"script":"a.py","args":[1]}]}', 'its build file cannot be read at its step 1'],
    ['{"version":1,"steps":[{"script":"a.py","page":"https://example.com"}]}', "its build file's step 1 holds 'page', which Modbench does not read"],
    ['{"version":1,"steps":[{"script":"a.py","defaultScript":"clean"}]}', "its build file cannot be read at its step 1: it names both 'script' and 'defaultScript'"],
    ['{"version":1,"steps":[{"unpack":{"a.ba2":["x.nif"]}}]}', "its build file's step 1 holds 'unpack', which Modbench does not read"],
    ['{"version":1,"steps":[{"copy":["a"],"compile":["A.esp"]}]}', "its build file cannot be read at its step 1: it names both 'compile' and 'copy'"],
    ['{"version":1,"steps":[{"copy":["a"],"args":[]}]}', "its build file's step 1 holds 'args', which Modbench does not read"],
    ['{"version":1,"steps":[{"copy":[]}]}', 'its build file cannot be read at its step 1: it names no path'],
    ['{"version":1,"steps":[{"copy":"a"}]}', 'its build file cannot be read at its step 1'],
    ['{"version":1,"steps":[{"copy":["a","a"]}]}', "its build file cannot be read at its step 1: it names 'a' twice"],
    ['{"version":1,"steps":[{"decompile":["../A.esp"]}]}', "its build file's step 1 names '../A.esp', which is not a path in the folder"],
    ['{"version":1,"steps":[{"compile":["plugins/A.esp"]}]}', "its build file cannot be read at its step 1: it names 'plugins/A.esp', which is not a plugin at the root"],
    ['{"version":1,"steps":[{"decompile":["originals/A.esp"]}]}', "its build file cannot be read at its step 1: it names 'originals/A.esp', which is not a plugin at the root"],
    ['{"version":1,"steps":[{"pack":{}}]}', 'its build file cannot be read at its step 1: it names no archive'],
    ['{"version":1,"steps":[{"pack":{"a.ba2":[]}}]}', "its build file cannot be read at its step 1: it names no file for 'a.ba2'"],
    ['{"version":1,"steps":[{"pack":{"a.ba2":["../x"]}}]}', "its build file's step 1 names '../x'"],
    ['{"version":1,"steps":[{"pack":{"a.esp:x":["a.nif"]}}]}', "its build file's step 1 names 'a.esp:x'"],
    ['{"version":1,"steps":[{"pack":{"a.ba2":["x.nif"],"b.ba2":["y.nif","x.nif"]}}]}', "its build file's step 1 names 'x.nif' in both 'a.ba2' and 'b.ba2'"],
    ['{"version":1,"steps":[{"pack":{"a.ba2":["x.nif","y.nif","x.nif"]}}]}', "its build file's step 1 names 'x.nif' twice in 'a.ba2'"],
    ['{"version":1,"steps":[{"pack":{"a.ba2":["X.nif"],"b.ba2":["x.NIF"]}}]}', "its build file's step 1 names 'x.NIF' in both 'a.ba2' and 'b.ba2'"],
    ['{"version":1,"steps":[{"pack":{"a.ba2":["x.nif","X.nif"]}}]}', "step 1 names 'X.nif' as 'x.nif' and 'X.nif' in 'a.ba2', which differ only by case"],
    ['{"version":1,"steps":[{"task":"Zip"},{"task":"Zip","page":"example.com/optimiser"}]}', 'its build file cannot be read at its step 2: its page is not a URI'],
    ['{"version":1,"steps":[{"task":""}]}', 'its build file cannot be read at its step 1: it names no task'],
    ['{"version":1,"steps":[{"task":"Zip","args":[1]}]}', 'its build file cannot be read at its step 1'],
    ['{"version":1,"steps":[{"task":"Zip","page":7}]}', 'its build file cannot be read at its step 1'],
    ['{"version":1,"steps":[{"task":"Zip","path":"C:/zip.exe"}]}', "its build file's step 1 holds 'path', which Modbench does not read"],
    ['{"version":1,"steps":[\n{"task":"a"}\n{"task":"b"}\n]}', 'line 3'],
  ])('refuses %j naming where', (text, where) => {
    const refused = read(text);
    expect('refused' in refused ? refused.refused : '').toContain(where);
  });
});
