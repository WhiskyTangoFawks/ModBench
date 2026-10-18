import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { importSpecifiers, isTestSupport, SRC } from './scanSource';
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
    function withPlantedTree(run: (root: string) => void): void {
      const root = mkdtempSync(join(tmpdir(), 'medit-context-boundary-'));
      try {
        run(root);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    it.each(NEVER_SEE_A_RECORD)('a FormKey import planted in a file of %s is caught', (box) => {
      withPlantedTree((root) => {
        mkdirSync(join(root, box), { recursive: true });
        writeFileSync(join(root, box, 'planted.ts'), "import type { FormKey } from '../wire/ApiClient';\n");
        expect(findOffenders(root)).toEqual([join(box, 'planted.ts')]);
      });
    });

    it('a test file or test folder is not caught, its names and fixtures being prose and corpus data', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'mods', 'test'), { recursive: true });
        writeFileSync(join(root, 'mods', 'modList.test.ts'), 'const formKey = 1;\n');
        writeFileSync(join(root, 'mods', 'test', 'fixture.ts'), 'const formKey = 1;\n');
        expect(findOffenders(root)).toEqual([]);
      });
    });

    const LIB_FILE = join('drivingLib', 'recordArgument.ts');
    const importingTheLibFile = "import { recordArgumentOf } from '../drivingLib/recordArgument';\n";
    const plantLibFileImportedFrom = (root: string, ...dirs: string[]) => {
      mkdirSync(join(root, 'drivingLib'), { recursive: true });
      writeFileSync(join(root, LIB_FILE), 'export const formKey = 1;\n');
      for (const dir of dirs) {
        mkdirSync(join(root, dir), { recursive: true });
        writeFileSync(join(root, dir, 'importer.ts'), importingTheLibFile);
      }
    };

    it('FormKey vocabulary in a driving lib file the Editing views alone import is not caught', () => {
      withPlantedTree((root) => {
        plantLibFileImportedFrom(root, 'editor', 'sourceLanguage');
        expect(findOffenders(root)).toEqual([]);
      });
    });

    it('FormKey vocabulary in a driving lib file a Mods-shaped file imports too is caught', () => {
      withPlantedTree((root) => {
        plantLibFileImportedFrom(root, 'editor', 'mods');
        expect(findOffenders(root)).toEqual([LIB_FILE]);
      });
    });

    it('FormKey vocabulary in a driving lib file a Mods-shaped file reaches through another lib file is caught', () => {
      withPlantedTree((root) => {
        plantLibFileImportedFrom(root, 'editor');
        writeFileSync(join(root, 'drivingLib', 'between.ts'), "export { recordArgumentOf } from './recordArgument';\n");
        mkdirSync(join(root, 'mods'), { recursive: true });
        writeFileSync(join(root, 'mods', 'importer.ts'), "import { recordArgumentOf } from '../drivingLib/between';\n");
        expect(findOffenders(root)).toEqual([LIB_FILE]);
      });
    });

    it('FormKey vocabulary in a driving lib file the Editing views alone reach through another lib file is not caught', () => {
      withPlantedTree((root) => {
        plantLibFileImportedFrom(root);
        writeFileSync(join(root, 'drivingLib', 'between.ts'), "export { recordArgumentOf } from './recordArgument';\n");
        mkdirSync(join(root, 'editor'), { recursive: true });
        writeFileSync(join(root, 'editor', 'importer.ts'), "import { recordArgumentOf } from '../drivingLib/between';\n");
        expect(findOffenders(root)).toEqual([]);
      });
    });

    it('the same FormKey import inside the Plugins view is not caught', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'mods'), { recursive: true });
        mkdirSync(join(root, 'plugins'), { recursive: true });
        const planted = "import type { FormKey } from '../wire/ApiClient';\n";
        writeFileSync(join(root, 'mods', 'ModListProvider.ts'), planted);
        writeFileSync(join(root, 'plugins', 'RecordBrowser.ts'), planted);
        expect(findOffenders(root)).toEqual([join('mods', 'ModListProvider.ts')]);
      });
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
    expect(domainVocabIn('// installationFile records which download it came from\nexport const x = 1;\n')).toEqual([]);
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
