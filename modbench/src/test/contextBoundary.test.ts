import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { importSpecifiers, isTestSupport, rootFiles, SRC } from './scanSource';
import { tsFiles } from './tsFiles';

const read = (relativePath: string) => readFileSync(join(SRC, relativePath), 'utf8');

const importsOf = (source: string): string[] => importSpecifiers(source, 'source.ts');

const CLIENT_DIR = 'client';
const PLUGINS_VIEW_DIR = 'plugins';
const EDITOR_DIR = 'editor';
const SOURCE_LANGUAGE_DIR = 'sourceLanguage';
const GENERATED_DIR = 'generated';
const WIRE_DIR = 'wire';

const COMPOSITION_ROOT = rootFiles().map((path) => relative(SRC, path));

const isEditingView = (relativePath: string): boolean =>
  [PLUGINS_VIEW_DIR, EDITOR_DIR, SOURCE_LANGUAGE_DIR].includes(relativePath.split(sep)[0] ?? '');

function isExcluded(relativePath: string): boolean {
  const segments = relativePath.split(sep);
  if (segments.includes(GENERATED_DIR)) return true;
  if (segments[0] === WIRE_DIR) return true;
  if (segments[0] === CLIENT_DIR) return true;
  if (isEditingView(relativePath)) return true;
  if (COMPOSITION_ROOT.includes(relativePath)) return true;
  if (isTestSupport(relativePath)) return true;
  return false;
}

function domainVocabIn(text: string): string[] {
  const code = text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  return [...code.matchAll(/\b(records?|formkeys?|recordtypes?|editorids?)\b(?!\s*<)/gi)].map((m) => m[0]);
}

const DRIVING_LIB_DIR = 'drivingLib';

const inDrivingLib = (relativePath: string): boolean => relativePath.split(sep)[0] === DRIVING_LIB_DIR;

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
  const offenses: string[] = [];
  const importersOf = importersOfLibFiles(root);
  const filesReaching = (libFile: string): string[] => {
    const libFiles = new Set([libFile]);
    const reaching = new Set<string>();
    for (const file of libFiles) {
      for (const importer of importersOf.get(file) ?? []) {
        const relImporter = relative(root, importer);
        if (inDrivingLib(relImporter)) libFiles.add(importer); else reaching.add(relImporter);
      }
    }
    return [...reaching];
  };
  const speaksForEditingAlone = (libFile: string): boolean => {
    const reaching = filesReaching(libFile);
    return reaching.some(isEditingView) && reaching.every(isExcluded);
  };
  for (const path of tsFiles(root)) {
    const relPath = relative(root, path);
    if (isExcluded(relPath)) continue;
    const text = readFileSync(path, 'utf8');
    const isEditingLibFile = inDrivingLib(relPath) && speaksForEditingAlone(path);
    if (!isEditingLibFile && domainVocabIn(text).length > 0) offenses.push(relPath);
  }
  return offenses;
}

describe('the MO2 side keys plugins by filename and origin, never by FormKey', () => {
  it('walks a real body of files', () => {
    expect(tsFiles(SRC).length).toBeGreaterThan(150);
  });

  it('the tree as it stands never carries FormKey vocabulary', () => {
    expect(findOffenders(SRC)).toEqual([]);
  });

  it('the raw walk reaches the Plugins view', () => {
    const reached = tsFiles(SRC).map((p) => relative(SRC, p));
    expect(reached).toEqual(expect.arrayContaining([join('plugins', 'PluginsTreeProvider.ts'), join('plugins', 'PluginTreeProvider.ts')]));
  });

  it('the Plugins view is skipped by a stated exclusion', () => {
    expect(isExcluded(join('plugins', 'PluginsTreeProvider.ts'))).toBe(true);
    expect(isExcluded(join('plugins', 'PluginTreeProvider.ts'))).toBe(true);
  });

  it('the editor folder is skipped by a stated exclusion, the same as Plugins', () => {
    expect(isExcluded(join('editor', 'recordPanelHost.ts'))).toBe(true);
  });

  it('the generated API client is excluded because it mirrors the backend schema', () => {
    expect(isExcluded(join(WIRE_DIR, GENERATED_DIR, 'api.ts'))).toBe(true);
  });

  it('the wire box is excluded, protocol and schema alike', () => {
    expect(isExcluded(join(WIRE_DIR, 'messages.ts'))).toBe(true);
  });

  it('the client box is excluded because it is the seam Editing speaks through, in the backend\'s own vocabulary', () => {
    expect(isExcluded(join(CLIENT_DIR, 'MEditClient.ts'))).toBe(true);
  });

  it('test files and test folders are excluded because their names and fixtures are prose and corpus data', () => {
    expect(isExcluded(join('mods', 'modList.test.ts'))).toBe(true);
    expect(isExcluded(join('mods', 'test', 'fixture.ts'))).toBe(true);
  });

  it('a file of the MO2 side is not excluded', () => {
    expect(isExcluded(join('mods', 'modList.ts'))).toBe(false);
  });

  it('the files at the root of src are excluded as the composition root', () => {
    expect(COMPOSITION_ROOT).toContain('extension.ts');
  });

  describe('a plant in each MO2-side directory is caught, and the same plant inside an excluded one is not', () => {
    function withPlantedTree(run: (root: string) => void): void {
      const root = mkdtempSync(join(tmpdir(), 'medit-context-boundary-'));
      try {
        run(root);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    it('a FormKey import planted in a Mods-shaped file is caught', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'mods'), { recursive: true });
        writeFileSync(join(root, 'mods', 'ModListProvider.ts'), "import type { FormKey } from '../wire/ApiClient';\n");
        expect(findOffenders(root)).toEqual([join('mods', 'ModListProvider.ts')]);
      });
    });

    const LIB_FILE = join('drivingLib', 'recordDocument.ts');
    const importingTheLibFile = "import { recordDocument } from '../drivingLib/recordDocument';\n";
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

    it('FormKey vocabulary in a driving lib file no view imports is caught', () => {
      withPlantedTree((root) => {
        plantLibFileImportedFrom(root);
        expect(findOffenders(root)).toEqual([LIB_FILE]);
      });
    });

    it('FormKey vocabulary in a driving lib file the composition root alone imports is caught', () => {
      withPlantedTree((root) => {
        plantLibFileImportedFrom(root);
        writeFileSync(join(root, 'extension.ts'), "import { recordDocument } from './drivingLib/recordDocument';\n");
        expect(findOffenders(root)).toEqual([LIB_FILE]);
      });
    });

    it('FormKey vocabulary in driving lib files that import each other and no view reaches is caught', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'drivingLib'), { recursive: true });
        writeFileSync(join(root, LIB_FILE), "import { between } from './between';\nexport const formKey = between;\n");
        writeFileSync(join(root, 'drivingLib', 'between.ts'), "import * as document from './recordDocument';\nexport const between = document;\n");
        expect(findOffenders(root)).toEqual([LIB_FILE]);
      });
    });

    it('FormKey vocabulary in a driving lib file a Mods-shaped file reaches through another lib file is caught', () => {
      withPlantedTree((root) => {
        plantLibFileImportedFrom(root, 'editor');
        writeFileSync(join(root, 'drivingLib', 'between.ts'), "export { recordDocument } from './recordDocument';\n");
        mkdirSync(join(root, 'mods'), { recursive: true });
        writeFileSync(join(root, 'mods', 'importer.ts'), "import { recordDocument } from '../drivingLib/between';\n");
        expect(findOffenders(root)).toEqual([LIB_FILE]);
      });
    });

    it('FormKey vocabulary in a driving lib file the Editing views alone reach through another lib file is not caught', () => {
      withPlantedTree((root) => {
        plantLibFileImportedFrom(root);
        writeFileSync(join(root, 'drivingLib', 'between.ts'), "export { recordDocument } from './recordDocument';\n");
        mkdirSync(join(root, 'editor'), { recursive: true });
        writeFileSync(join(root, 'editor', 'importer.ts'), "import { recordDocument } from '../drivingLib/between';\n");
        expect(findOffenders(root)).toEqual([]);
      });
    });

    it('the same FormKey import inside the Plugins view is not caught — the walk still reaches it', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'mods'), { recursive: true });
        mkdirSync(join(root, 'plugins'), { recursive: true });
        const planted = "import type { FormKey } from '../wire/ApiClient';\n";
        writeFileSync(join(root, 'mods', 'ModListProvider.ts'), planted);
        writeFileSync(join(root, 'plugins', 'PluginTreeProvider.ts'), planted);
        const reached = tsFiles(root).map((p) => relative(root, p));
        expect(reached).toEqual(expect.arrayContaining([join('plugins', 'PluginTreeProvider.ts')]));
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
