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
  + '{"kind":"installationFile","name":"B.7z","size":2,"hash":"BBBBBBBBBBA=","host":{"url":"https://f4se.silverlock.org/beta/f4se_0_06_23.7z"}},\n'
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

const withIgnore = (
  '{\n'
  + '"version":1,\n'
  + '"exclude":[\n'
  + '"x.esp"\n'
  + '],\n'
  + '"ignore":[\n'
  + '"F4SE/Plugins/BetterConsole.mem",\n'
  + '"logs"\n'
  + '],\n'
  + '"files":{\n'
  + '"x.esp":"BBBBBBBBBBA="\n'
  + '}\n'
  + '}\n'
);

const withFlags = (
  '{\n'
  + '"version":1,\n'
  + '"packages":[\n'
  + '{"kind":"installationFile","name":"a.7z","size":1,"hash":"AAAAAAAAAAA="}\n'
  + '],\n'
  + '"flags":{\n'
  + '"Mod.esp":{"Master":false,"Small":true},\n'
  + '"real/Other.esl":{"Master":true}\n'
  + '},\n'
  + '"files":{\n'
  + '"Mod.esp":"BBBBBBBBBBA=",\n'
  + '"real/Other.esl":"AAAAAAAAAAA="\n'
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
    ['ignored paths, between exclusions and files', withIgnore],
    ['flags, between ignore and files, with each plugin\'s flags by name', withFlags],
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
      ignore: ['d', 'C'],
      flags: new Map(),
      files: new Map([['b', H1], ['B', H1], ['A', H2], ['a', H2]]),
    };
    expect(manifestText(manifest)).toBe(
      '{\n"version":1,\n"packages":[\n'
      + `{"kind":"installationFile","name":"a.7z","size":1,"hash":"${H1}"},\n`
      + `{"kind":"installationFile","name":"B.7z","size":1,"hash":"${H2}"},\n`
      + `{"kind":"installationFile","name":"b.7z","size":1,"hash":"${H1}"},\n`
      + '{"kind":"gameFolder"}\n],\n'
      + '"exclude":[\n"A",\n"b"\n],\n'
      + '"ignore":[\n"C",\n"d"\n],\n'
      + `"files":{\n"A":"${H2}",\n"a":"${H2}",\n"B":"${H1}",\n"b":"${H1}"\n}\n}\n`,
    );
  });

  it('reads any text the schema accepts, whatever its spacing and order', () => {
    const read = readManifest(`{ "files": { "a.esp": "${H1}" }, "version": 1 }`);
    expect(read).toEqual({ manifest: { packages: [], exclude: [], ignore: [], flags: new Map(), files: new Map([['a.esp', H1]]) } });
  });
});

describe('a manifest the adapter refuses', () => {
  it('refuses a manifest of the format before version 1, saying update manifest may write it over', () => {
    expect(readManifest('{\n"files": [\n{"path":"a.txt"}\n]\n}\n')).toEqual({
      refused: 'its manifest is in a format before version 1, and Modbench reads only version 1', olderFormat: true,
    });
  });

  it('refuses a manifest of another version, naming both (formats/CLAUDE.md, Versions)', () => {
    expect(readManifest('{"version":2}')).toEqual({ refused: 'its manifest is version 2, and Modbench reads only version 1' });
  });

  it.each([
    ['<<<<<<< HEAD\n', 'line 1'],
    ['{\n"version":1,\n<<<<<<< HEAD\n}\n', 'line 3'],
    ['{\n"version":1,\n"exclude": [\n"a"\n"b"\n]\n}\n', 'line 5'],
    ['line 5 {', 'line 1'],
    ['{"version":1', 'line 1'],
    ['[]', 'its manifest cannot be read'],
    ['{"version":1,"extra":1}', "its manifest holds 'extra', which Modbench does not read"],
    [`{"version":1,"files":{"a.esp":"${H1}x"}}`, "its manifest cannot be read at its file 'a.esp'"],
    ['{"version":1,"files":{"a.esp":null}}', "its manifest cannot be read at its file 'a.esp': only a source mod's manifest names a file a step makes"],
    [`{"version":1,"files":{"../a.esp":"${H1}"}}`, "its manifest names '../a.esp', which is not a path in the folder"],
    [`{"version":1,"files":{"a\\\\b.esp":"${H1}"}}`, "which is not a path in the folder"],
    [`{"version":1,"files":{"a/":"${H1}"}}`, "which is not a path in the folder"],
    [`{"version":1,"files":{"C:/x":"${H1}"}}`, "its manifest names 'C:/x', which is not a path in the folder"],
    [`{"version":1,"files":{"C:x":"${H1}"}}`, "its manifest names 'C:x', which is not a path in the folder"],
    [`{"version":1,"files":{"a.esp:x":"${H1}"}}`, "its manifest names 'a.esp:x', which is not a path in the folder"],
    [`{"version":1,"files":{"A.esp":"${H1}","a.esp":"${H1}"}}`, "its manifest names 'A.esp' and 'a.esp', which differ only by case"],
    [`{"version":1,"exclude":["b.esp"],"files":{"a.esp":"${H1}"}}`, "its manifest excludes 'b.esp', which is none of its files nor a folder above one"],
    [`{"version":1,"exclude":["a","a"],"files":{"a/b.esp":"${H1}"}}`, "its manifest excludes 'a' twice"],
    ['{"version":1,"ignore":["a","a"]}', "its manifest ignores 'a' twice"],
    ['{"version":1,"ignore":["../a"]}', "its manifest names '../a', which is not a path in the folder"],
    [`{"version":1,"ignore":["a.esp"],"files":{"a.esp":"${H1}"}}`, "its manifest ignores 'a.esp', which is one of its files or a folder above one"],
    [`{"version":1,"ignore":["docs"],"files":{"docs/a.txt":"${H1}"}}`, "its manifest ignores 'docs', which is one of its files or a folder above one"],
    [`{"version":1,"flags":{"a.esp":{"Master":true}}}`, "its manifest flags 'a.esp', which is none of its files"],
    [`{"version":1,"flags":{"a.txt":{"Master":true}},"files":{"a.txt":"${H1}"}}`, "its manifest flags 'a.txt', which is no plugin"],
    [`{"version":1,"flags":{"a.esp":{}},"files":{"a.esp":"${H1}"}}`, "its manifest cannot be read at its flags of 'a.esp'"],
    [`{"version":1,"flags":{"a.esp":{"Master":1}},"files":{"a.esp":"${H1}"}}`, "its manifest cannot be read at its flags of 'a.esp'"],
    [`{"version":1,"packages":[{"kind":"repository","name":"Mod"}],"flags":{"a.esp":{"Master":true}},"files":{"a.esp":"${H1}"}}`, "its manifest flags 'a.esp' beside the repository 'Mod'"],
    [`{"version":1,"packages":[{"kind":"installationFile","name":"A.zip","size":1,"hash":"${H1}"},{"kind":"installationFile","name":"A.zip","size":2,"hash":"${H2}"}]}`, "its manifest names the installation file 'A.zip' twice"],
    ['{"version":1,"packages":[{"kind":"gameFolder"},{"kind":"gameFolder"}]}', 'its manifest names the game folder twice'],
    ['{"version":1,"packages":[{"kind":"repository","name":"Mod"},{"kind":"gameFolder"}]}', "its manifest names the repository 'Mod' beside another package"],
    ['{"version":1,"packages":[{"kind":"installationFile","name":"A.zip"}]}', 'its manifest cannot be read at its package 1'],
    [`{"version":1,"packages":[{"kind":"installationFile","name":"A.zip","size":1,"hash":"${H1}","page":"x"}]}`, "its manifest's package 1 holds 'page', which Modbench does not read"],
    [`{"version":1,"packages":[{"kind":"installationFile","name":"A.zip","size":1,"hash":"${H1}","host":{"nexus":{"game":"Fallout 4","mod":1,"file":1}}}]}`, 'its manifest cannot be read at its package 1'],
    [`{"version":1,"packages":[{"kind":"installationFile","name":"A.zip","size":1,"hash":"${H1}","host":{"url":"not an address"}}]}`, 'its manifest cannot be read at its package 1'],
    [`{"version":1,"packages":[{"kind":"installationFile","name":"A.zip","size":1,"hash":"${H1}","host":{"url":"ftp://example.com/A.zip"}}]}`, 'its manifest cannot be read at its package 1'],
    [`{"version":1,"packages":[{"kind":"installationFile","name":"A.zip","size":1,"hash":"${H1}","host":{"url":"https://example.com/A.zip","nexus":{"game":"fallout4","mod":1,"file":1}}}]}`, 'its manifest cannot be read at its package 1'],
    [`{"version":1,"packages":[{"kind":"installationFile","name":"A.zip","size":1,"hash":"${H1}","host":{}}]}`, 'its manifest cannot be read at its package 1'],
    ['{"version":1,"packages":[{"kind":"gameFolder","host":{"steam":{"app":0}}}]}', 'its manifest cannot be read at its package 1'],
    ['{"version":1,"packages":[{"kind":"gameFolder","host":{"steam":{"app":1,"depots":{"a":"1"}}}}]}', 'its manifest cannot be read at its package 1'],
    ['{"version":1,"packages":[{"kind":"submodule","name":"Mod"}]}', 'its manifest cannot be read at its package 1'],
  ])('refuses %j naming where', (text, where) => {
    const read = readManifest(text);
    expect('refused' in read ? read.refused : '').toContain(where);
  });
});
