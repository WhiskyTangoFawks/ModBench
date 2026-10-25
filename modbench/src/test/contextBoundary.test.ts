import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { importSpecifiers, isTestSupport, plantedTree, SRC } from './scanSource';
import { tsFiles } from './tsFiles';

const read = (relativePath: string) => readFileSync(join(SRC, relativePath), 'utf8');

const importsOf = (source: string): string[] => importSpecifiers(source, 'source.ts');

const NEVER_SEE_A_RECORD = ['mods', 'downloads', 'toolbox'];
const DRIVING_LIB_DIR = 'drivingLib';

const boxOf = (relativePath: string): string => relativePath.split(sep)[0] ?? '';

const inDrivingLib = (relativePath: string): boolean => boxOf(relativePath) === DRIVING_LIB_DIR;

const seesNoRecord = (relativePath: string): boolean =>
  NEVER_SEE_A_RECORD.includes(boxOf(relativePath)) && !isTestSupport(relativePath);

function domainVocabIn(text: string): string[] {
  const code = text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  return [...code.matchAll(/\b(records?|formkeys?|recordtypes?|editorids?)\b(?!\s*<)/gi)].map((m) => m[0]);
}

function importersOfLibFiles(root: string): Map<string, string[]> {
  const importers = new Map<string, string[]>();
  for (const path of tsFiles(root)) {
    const text = readFileSync(path, 'utf8');
    if (isTestSupport(relative(root, path)) || !(inDrivingLib(relative(root, path)) || text.includes(DRIVING_LIB_DIR))) continue;
    for (const imported of importsOf(text).filter((s) => s.startsWith('.')).map((s) => `${join(dirname(path), s)}.ts`)) {
      importers.set(imported, [...(importers.get(imported) ?? []), path]);
    }
  }
  return importers;
}

function findOffenders(root: string): string[] {
  const importersOf = importersOfLibFiles(root);
  const reachedFromABoxThatSeesNoRecord = (libFile: string): boolean => {
    const libFiles = new Set([libFile]);
    const reaching = new Set<string>();
    for (const file of libFiles) {
      for (const importer of importersOf.get(file) ?? []) {
        const relImporter = relative(root, importer);
        if (inDrivingLib(relImporter)) libFiles.add(importer); else reaching.add(relImporter);
      }
    }
    return [...reaching].some(seesNoRecord);
  };
  return tsFiles(root)
    .filter((path) => {
      const relPath = relative(root, path);
      return seesNoRecord(relPath) || (inDrivingLib(relPath) && !isTestSupport(relPath) && reachedFromABoxThatSeesNoRecord(path));
    })
    .filter((path) => domainVocabIn(readFileSync(path, 'utf8')).length > 0)
    .map((path) => relative(root, path));
}

describe('Mods, Downloads and Toolbox never see a record (target-architecture.md): they key plugins by filename and origin, never by FormKey', () => {
  it('walks a real body of files', () => {
    expect(tsFiles(SRC).length).toBeGreaterThan(150);
  });

  it('the tree as it stands never carries FormKey vocabulary', () => {
    expect(findOffenders(SRC)).toEqual([]);
  });

  it('the walk reaches each box that never sees a record', () => {
    expect(tsFiles(SRC).map((p) => boxOf(relative(SRC, p)))).toEqual(expect.arrayContaining(NEVER_SEE_A_RECORD));
  });

  describe('a plant in each box that never sees a record is caught, and the same plant in another box is not', () => {
    const FORMKEY_IMPORT = "import type { FormKey } from '../wire/ApiClient';\n";

    it.each(NEVER_SEE_A_RECORD)('a FormKey import planted in a file of %s is caught', (box) => {
      expect(findOffenders(plantedTree({ [`${box}/planted.ts`]: FORMKEY_IMPORT }))).toEqual([join(box, 'planted.ts')]);
    });

    it('a test file or test folder is not caught, its names and fixtures being prose and corpus data', () => {
      expect(findOffenders(plantedTree({ 'mods/modList.test.ts': 'const formKey = 1;\n', 'mods/test/fixture.ts': 'const formKey = 1;\n' }))).toEqual([]);
    });

    it('the same FormKey import inside the Plugins view is not caught', () => {
      expect(findOffenders(plantedTree({ 'mods/ModListProvider.ts': FORMKEY_IMPORT, 'plugins/RecordBrowser.ts': FORMKEY_IMPORT })))
        .toEqual([join('mods', 'ModListProvider.ts')]);
    });

    const LIB_FILE = join('drivingLib', 'recordArgument.ts');
    const importingTheLibFile = "import { recordArgumentOf } from '../drivingLib/recordArgument';\n";
    const importingThroughAnother = "import { recordArgumentOf } from '../drivingLib/between';\n";
    const anotherLibFile = { 'drivingLib/between.ts': "export { recordArgumentOf } from './recordArgument';\n" };

    it.each<[string, Record<string, string>, string[]]>([
      ['the Editing views alone import is not caught', { 'editor/importer.ts': importingTheLibFile, 'sourceLanguage/importer.ts': importingTheLibFile }, []],
      ['a Mods-shaped file imports too is caught', { 'editor/importer.ts': importingTheLibFile, 'mods/importer.ts': importingTheLibFile }, [LIB_FILE]],
      ['a Mods-shaped file reaches through another lib file is caught',
        { 'editor/importer.ts': importingTheLibFile, ...anotherLibFile, 'mods/importer.ts': importingThroughAnother }, [LIB_FILE]],
      ['the Editing views alone reach through another lib file is not caught', { ...anotherLibFile, 'editor/importer.ts': importingThroughAnother }, []],
    ])('FormKey vocabulary in a driving lib file %s', (_, importers, offenders) => {
      expect(findOffenders(plantedTree({ 'drivingLib/recordArgument.ts': 'export const formKey = 1;\n', ...importers }))).toEqual(offenders);
    });
  });

  it('does not flag the built-in Record<K, V> utility type', () => {
    expect(domainVocabIn('const dirs: Record<string, boolean> = {};\n')).toEqual([]);
  });

  it('flags the domain word once it is not that generic type', () => {
    expect(domainVocabIn('const formKey: string = x;\n')).toEqual(['formKey']);
    expect(domainVocabIn('type Row = { editorId: string };\n')).toEqual(['editorId']);
  });

  it('prose in a comment is exempt', () => {
    expect(domainVocabIn('// installationFile records which downloaded file it came from\nexport const x = 1;\n')).toEqual([]);
  });
});

describe('the load-order sender belongs to Editing alone', () => {
  const SENDER = 'client/loadOrderSender.ts';

  it('carries none of Mod Management\'s vocabulary', () => {
    const code = read(SENDER)
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect([...code.matchAll(/\b(mods?|modlists?|profiles?)\b/gi)].map((m) => m[0])).toEqual([]);
  });
});
