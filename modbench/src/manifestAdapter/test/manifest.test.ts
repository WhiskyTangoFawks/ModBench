import { describe, it, expect } from 'vitest';
import { manifestText } from '../manifestText';
import { readManifest } from '../manifestRead';
import type { Manifest } from '../manifestAdapter';

const H1 = 'AAAAAAAAAAA=';
const H2 = 'BBBBBBBBBBA=';

const specExample = (
  '{\n'
  + '"version":1,\n'
  + '"packages":[\n'
  + '{"kind":"installationFile","name":"Accessible Bridges-74189-1-3.7z","size":1736415,"hash":"2xdzlSxY/4k=","host":{"nexus":{"game":"fallout4","mod":74189,"file":371740}}}\n'
  + '],\n'
  + '"files":{\n'
  + '"AccessibleBridges.esp":"Qm9yZGVyczE="\n'
  + '}\n'
  + '}\n'
);

const everyKindAndExclusion = (
  '{\n'
  + '"version":1,\n'
  + '"packages":[\n'
  + '{"kind":"installationFile","name":"a.7z","size":1,"hash":"AAAAAAAAAAA="},\n'
  + '{"kind":"installationFile","name":"B.7z","size":2,"hash":"BBBBBBBBBBA="},\n'
  + '{"kind":"gameFolder","host":{"steam":{"app":377160,"depots":{"377161":"11","1234567":"22"}}}}\n'
  + '],\n'
  + '"exclude":[\n'
  + '"docs",\n'
  + '"x.esp"\n'
  + '],\n'
  + '"files":{\n'
  + '"docs/readme.txt":"AAAAAAAAAAA=",\n'
  + '"x.esp":"BBBBBBBBBBA="\n'
  + '}\n'
  + '}\n'
);

const builtSourceMod = (
  '{\n'
  + '"version":1,\n'
  + '"packages":[\n'
  + '{"kind":"repository","name":"Mod"}\n'
  + '],\n'
  + '"files":{\n'
  + '"Mod.esp":"AAAAAAAAAAA=",\n'
  + '"textures/made.dds":null\n'
  + '}\n'
  + '}\n'
);

const noMember = '{\n"version":1\n}\n';

describe('a manifest the adapter reads and writes', () => {
  it.each([
    ['the example formats/manifest.md gives', specExample],
    ['every kind of package but a repository, and exclusions', everyKindAndExclusion],
    ['a built source mod, with a file a step makes', builtSourceMod],
    ['a manifest with no member but its version', noMember],
  ])('round-trips %s byte for byte', (_name, text) => {
    const read = readManifest(text);
    if (!('manifest' in read)) throw new Error(read.refused);
    expect(manifestText(read.manifest)).toBe(text);
  });

  it('reads each file by its path with its hash, and a file a step makes with none', () => {
    const read = readManifest(builtSourceMod);
    if (!('manifest' in read)) throw new Error(read.refused);
    expect([...read.manifest.files]).toEqual([['Mod.esp', H1], ['textures/made.dds', null]]);
  });

  it('writes packages in the schema\'s order of kinds, installation files by name, and paths by path, ignoring case first', () => {
    const manifest: Manifest = {
      packages: [
        { kind: 'gameFolder' }, { kind: 'installationFile', name: 'b.7z', size: 1, hash: H1 }, { kind: 'installationFile', name: 'B.7z', size: 1, hash: H2 },
        { kind: 'installationFile', name: 'a.7z', size: 1, hash: H1 },
      ],
      exclude: ['b', 'A'],
      files: new Map([['b', H1], ['B', H1], ['A', H2], ['a', H2]]),
    };
    expect(manifestText(manifest)).toBe(
      '{\n"version":1,\n"packages":[\n'
      + `{"kind":"installationFile","name":"a.7z","size":1,"hash":"${H1}"},\n`
      + `{"kind":"installationFile","name":"B.7z","size":1,"hash":"${H2}"},\n`
      + `{"kind":"installationFile","name":"b.7z","size":1,"hash":"${H1}"},\n`
      + '{"kind":"gameFolder"}\n],\n'
      + '"exclude":[\n"A",\n"b"\n],\n'
      + `"files":{\n"A":"${H2}",\n"a":"${H2}",\n"B":"${H1}",\n"b":"${H1}"\n}\n}\n`,
    );
  });

  it('reads any text the schema accepts, whatever its spacing and order', () => {
    const read = readManifest(`{ "files": { "a.esp": "${H1}" }, "version": 1 }`);
    expect(read).toEqual({ manifest: { packages: [], exclude: [], files: new Map([['a.esp', H1]]) } });
  });
});

describe('a manifest the adapter refuses', () => {
  it.each([
    ['{\n"files": [\n{"path":"a.txt"}\n]\n}\n', 'its manifest is in a format before version 1, and Modbench reads only version 1'],
    ['{"version":2}', 'its manifest is version 2, and Modbench reads only version 1'],
  ])('refuses %j, naming both versions', (text, refused) => {
    expect(readManifest(text)).toEqual({ refused, versionRefused: true });
  });

  it.each([
    ['<<<<<<< HEAD\n', 'line 1'],
    ['{\n"version":1,\n<<<<<<< HEAD\n}\n', 'line 3'],
    ['[]', 'its manifest cannot be read'],
    ['{"version":1,"extra":1}', "its manifest holds 'extra', which Modbench does not read"],
    [`{"version":1,"files":{"a.esp":"${H1}x"}}`, "its manifest cannot be read at its file 'a.esp'"],
    ['{"version":1,"files":{"a.esp":null}}', "its manifest cannot be read at its file 'a.esp': only a source mod's manifest names a file a step makes"],
    [`{"version":1,"files":{"../a.esp":"${H1}"}}`, "its manifest names '../a.esp', which is not a path in the folder"],
    [`{"version":1,"files":{"a\\\\b.esp":"${H1}"}}`, "which is not a path in the folder"],
    [`{"version":1,"files":{"a/":"${H1}"}}`, "which is not a path in the folder"],
    [`{"version":1,"files":{"A.esp":"${H1}","a.esp":"${H1}"}}`, "its manifest names 'A.esp' and 'a.esp', which differ only by case"],
    [`{"version":1,"exclude":["b.esp"],"files":{"a.esp":"${H1}"}}`, "its manifest excludes 'b.esp', which is none of its files nor a folder above one"],
    [`{"version":1,"exclude":["a","a"],"files":{"a/b.esp":"${H1}"}}`, "its manifest excludes 'a' twice"],
    [`{"version":1,"packages":[{"kind":"installationFile","name":"A.zip","size":1,"hash":"${H1}"},{"kind":"installationFile","name":"A.zip","size":2,"hash":"${H2}"}]}`, "its manifest names the installation file 'A.zip' twice"],
    ['{"version":1,"packages":[{"kind":"gameFolder"},{"kind":"gameFolder"}]}', 'its manifest names the game folder twice'],
    ['{"version":1,"packages":[{"kind":"repository","name":"Mod"},{"kind":"gameFolder"}]}', "its manifest names the repository 'Mod' beside another package"],
    ['{"version":1,"packages":[{"kind":"installationFile","name":"A.zip"}]}', 'its manifest cannot be read at its package 1'],
    [`{"version":1,"packages":[{"kind":"installationFile","name":"A.zip","size":1,"hash":"${H1}","page":"x"}]}`, "its manifest's package 1 holds 'page', which Modbench does not read"],
    [`{"version":1,"packages":[{"kind":"installationFile","name":"A.zip","size":1,"hash":"${H1}","host":{"nexus":{"game":"Fallout 4","mod":1,"file":1}}}]}`, 'its manifest cannot be read at its package 1'],
    [`{"version":1,"packages":[{"kind":"installationFile","name":"A.zip","size":1,"hash":"${H1}","host":{}}]}`, 'its manifest cannot be read at its package 1'],
    ['{"version":1,"packages":[{"kind":"gameFolder","host":{"steam":{"app":0}}}]}', 'its manifest cannot be read at its package 1'],
    ['{"version":1,"packages":[{"kind":"gameFolder","host":{"steam":{"app":1,"depots":{"a":"1"}}}}]}', 'its manifest cannot be read at its package 1'],
    ['{"version":1,"packages":[{"kind":"submodule","name":"Mod"}]}', 'its manifest cannot be read at its package 1'],
  ])('refuses %j naming where', (text, where) => {
    const read = readManifest(text);
    expect('refused' in read ? read.refused : '').toContain(where);
  });
});
