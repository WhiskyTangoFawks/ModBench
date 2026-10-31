import { describe, it, expect } from 'vitest';
import { readBuildFile } from '../buildFileRead';

const read = (text: string): ReturnType<typeof readBuildFile> => readBuildFile(text);

describe('a build file the adapter reads and refuses', () => {
  it('reads each step with the page of its tool and each archive with the files it packs', () => {
    const text = JSON.stringify({
      version: 1,
      steps: [{ task: 'Optimise textures', args: ['--in', 'textures'], page: 'https://example.com/optimiser' }, { task: 'Archive' }],
      archives: { 'mod.ba2': ['a.nif', 'b.nif'] },
    });

    expect(read(text)).toEqual({
      buildFile: {
        steps: [{ task: 'Optimise textures', args: ['--in', 'textures'], page: 'https://example.com/optimiser' }, { task: 'Archive', args: [] }],
        archives: [{ path: 'mod.ba2', files: ['a.nif', 'b.nif'] }],
      },
    });
  });

  it('reads a build file that holds only its version', () => {
    expect(read('{"version":1}')).toEqual({ buildFile: { steps: [], archives: [] } });
  });

  it.each([
    ['{"steps": []}', 'its build file is in a format before version 1, and Modbench reads only version 1'],
    ['{"packages": [], "files": []}', 'its build file is in a format before version 1, and Modbench reads only version 1'],
    ['{"version":2}', 'its build file is version 2, and Modbench reads only version 1'],
    ['{"version":"1"}', 'its build file is version "1", and Modbench reads only version 1'],
    ['{"version":1,"tools":[]}', "its build file holds 'tools', which Modbench does not read"],
    ['{"version":1,"files":[]}', "its build file holds 'files', which Modbench does not read"],
    ['{"version":1,"packages":[]}', "its build file holds 'packages', which Modbench does not read"],
    ['{"version":1,"exclude":[]}', "its build file holds 'exclude', which Modbench does not read"],
    ['{"version":1,"archives":{"a.ba2":["../x"]}}', "its build file's 'archives' names '../x'"],
    ['{"version":1,"archives":{"a.ba2":["C:/x"]}}', "its build file's 'archives' names 'C:/x'"],
    ['{"version":1,"archives":{"a.esp:x":["a.nif"]}}', "its build file's 'archives' names 'a.esp:x'"],
    ['{"version":1,"steps":[{"task":""}]}', 'its build file cannot be read at its step 1: it names no task'],
    ['{"version":1,"steps":[{"args":["a"]}]}', 'its build file cannot be read at its step 1'],
    ['{"version":1,"steps":[{"task":"Zip","args":[1]}]}', 'its build file cannot be read at its step 1'],
    ['{"version":1,"steps":[{"task":"Zip","page":7}]}', 'its build file cannot be read at its step 1'],
    ['{"version":1,"steps":[{"task":"Zip","path":"C:/zip.exe"}]}', "its build file's step 1 holds 'path', which Modbench does not read"],
    ['{"version":1,"steps":[\n{"task":"a"}\n{"task":"b"}\n]}', 'line 3'],
  ])('refuses %j naming where', (text, where) => {
    const refused = read(text);
    expect('refused' in refused ? refused.refused : '').toContain(where);
  });
});
