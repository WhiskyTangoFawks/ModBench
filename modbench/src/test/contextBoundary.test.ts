import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { present } from '../ports/present';
import { tsFiles } from './tsFiles';

const SRC = join(__dirname, '..');

const read = (relativePath: string) => readFileSync(join(SRC, relativePath), 'utf8');

function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:import|export)[\s\S]*?from\s+'([^']+)'/g)]
    .map((m) => present(m[1], 'the module-path capture group the pattern always matches'));
}

const EDITING_DIR = 'medit';
const CLIENT_DIR = 'client';
const PLUGINS_VIEW_DIR = 'plugins';
const EDITOR_DIR = 'editor';
const GENERATED_DIR = 'generated';
const WIRE_DIR = 'wire';

const WIRES_EVERY_CONTEXT = ['toolbox.ts', 'toolboxClientCalls.ts', 'extension.ts'];
const SHARED_ACTIVATION_STATE = ['session.ts'];
const MEDIT_PATH_FALSE_POSITIVE = ['workspaceConfig.ts'];
const CHECKBOX_HANDLER_WIRING = ['pluginCheckboxHandler.ts'];
const CLIENT_CALLERS = ['instanceCommands'];

const COMPOSITION_ROOT =
  [...WIRES_EVERY_CONTEXT, ...SHARED_ACTIVATION_STATE, ...MEDIT_PATH_FALSE_POSITIVE, ...CHECKBOX_HANDLER_WIRING];

function isTestSupport(relativePath: string): boolean {
  return relativePath.split(sep).some((seg) => seg === 'test' || seg === 'integration') || relativePath.includes('.test.');
}

function isExcluded(relativePath: string): boolean {
  const segments = relativePath.split(sep);
  if (segments.includes(GENERATED_DIR)) return true;
  if (segments[0] === WIRE_DIR) return true;
  if (segments[0] === PLUGINS_VIEW_DIR) return true;
  if (segments[0] === EDITING_DIR) return true;
  if (segments[0] === CLIENT_DIR) return true;
  if (segments[0] === EDITOR_DIR) return true;
  if (COMPOSITION_ROOT.includes(relativePath)) return true;
  if (isTestSupport(relativePath)) return true;
  return false;
}

function domainVocabIn(text: string): string[] {
  const code = text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  return [...code.matchAll(/\b(records?|formkeys?|recordtypes?|editorids?)\b(?!\s*<)/gi)].map((m) => m[0]);
}

interface Offense { path: string; crossContext: string[]; vocab: string[] }

function importsFromDir(imports: string[], dir: string): string[] {
  return imports.filter((s) => s.split('/').includes(dir));
}

function findOffenders(root: string): Offense[] {
  const offenses: Offense[] = [];
  for (const path of tsFiles(root)) {
    const relPath = relative(root, path);
    if (isExcluded(relPath)) continue;
    const text = readFileSync(path, 'utf8');
    const imports = importsOf(text);
    const clientImports = CLIENT_CALLERS.includes(relPath.split(sep)[0] ?? '') ? [] : importsFromDir(imports, CLIENT_DIR);
    const crossContext = [
      ...importsFromDir(imports, EDITING_DIR), ...clientImports,
      ...importsFromDir(imports, PLUGINS_VIEW_DIR), ...importsFromDir(imports, EDITOR_DIR),
    ];
    const vocab = domainVocabIn(text);
    if (crossContext.length > 0 || vocab.length > 0) offenses.push({ path: relPath, crossContext, vocab });
  }
  return offenses;
}

describe('the MO2 side keys plugins by filename and origin, never by FormKey', () => {
  it('walks a real body of files', () => {
    expect(tsFiles(SRC).length).toBeGreaterThan(150);
  });

  it('the tree as it stands never imports the mEdit client or carries FormKey vocabulary', () => {
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

  it('Editing\'s folder is excluded because it is its own context, not the MO2 side', () => {
    expect(isExcluded(join(EDITING_DIR, 'editing.ts'))).toBe(true);
  });

  it('test files and test folders are excluded because their names and fixtures are prose and corpus data', () => {
    expect(isExcluded(join('mods', 'modList.test.ts'))).toBe(true);
    expect(isExcluded(join('mods', 'test', 'fixture.ts'))).toBe(true);
  });

  it('a file of the MO2 side is not excluded', () => {
    expect(isExcluded(join('mods', 'modList.ts'))).toBe(false);
  });

  it('the composition-root allowlist is exactly these six files', () => {
    expect(COMPOSITION_ROOT.sort()).toEqual(
      ['extension.ts', 'pluginCheckboxHandler.ts', 'session.ts', 'toolbox.ts', 'toolboxClientCalls.ts', 'workspaceConfig.ts']);
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
        writeFileSync(join(root, 'mods', 'ModListProvider.ts'), "import type { FormKey } from '../medit/ApiClient';\n");
        expect(findOffenders(root).map((o) => o.path)).toEqual([join('mods', 'ModListProvider.ts')]);
      });
    });

    it('an mEdit-client import planted in a Downloads-shaped file is caught', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'downloads'), { recursive: true });
        writeFileSync(join(root, 'downloads', 'DownloadsProvider.ts'), "import { ApiPluginRepository } from '../medit/PluginRepository';\n");
        expect(findOffenders(root).map((o) => o.path)).toEqual([join('downloads', 'DownloadsProvider.ts')]);
      });
    });

    it('a Plugins-view import planted in a MO2-shaped file is caught', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'mods'), { recursive: true });
        writeFileSync(join(root, 'mods', 'ModListProvider.ts'), "import { ErrorNode } from '../plugins/PluginTreeProvider';\n");
        expect(findOffenders(root).map((o) => o.path)).toEqual([join('mods', 'ModListProvider.ts')]);
      });
    });

    it('an MO2-side module named pluginsText is not caught by the Plugins-view check', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'mods', 'mo2'), { recursive: true });
        writeFileSync(join(root, 'mods', 'mo2', 'pluginsText.ts'), 'export const x = 1;\n');
        writeFileSync(join(root, 'mods', 'ModListProvider.ts'), "import { parsePlugins } from './mo2/pluginsText';\n");
        expect(findOffenders(root)).toEqual([]);
      });
    });

    it('an mEdit-client import planted in the Instance file itself is caught, at its real nested depth', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'instanceLoader'), { recursive: true });
        writeFileSync(join(root, 'instanceLoader', 'instance.ts'), "import { EditingController } from '../medit/EditingController';\n");
        expect(findOffenders(root).map((o) => o.path)).toEqual([join('instanceLoader', 'instance.ts')]);
      });
    });

    it('a Toolbox-shaped file that imports the mEdit client is caught', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'toolbox'), { recursive: true });
        writeFileSync(join(root, 'toolbox', 'ToolboxProvider.ts'), "import type { MEditClient } from '../client';\n");
        expect(findOffenders(root).map((o) => o.path)).toEqual([join('toolbox', 'ToolboxProvider.ts')]);
      });
    });

    it('the mEdit-client import is exempt in instance commands alone', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'instanceCommands'), { recursive: true });
        mkdirSync(join(root, 'mods'), { recursive: true });
        const planted = "import type { LoadOrderSender } from '../client';\n";
        writeFileSync(join(root, 'instanceCommands', 'loadOrder.ts'), planted);
        writeFileSync(join(root, 'mods', 'ModListProvider.ts'), planted);
        expect(findOffenders(root).map((o) => o.path)).toEqual([join('mods', 'ModListProvider.ts')]);
      });
    });

    it('instance commands reaching Editing or the Plugins view are still caught', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'instanceCommands'), { recursive: true });
        writeFileSync(join(root, 'instanceCommands', 'loadOrder.ts'), "import { ErrorNode } from '../plugins/PluginTreeProvider';\n");
        expect(findOffenders(root).map((o) => o.path)).toEqual([join('instanceCommands', 'loadOrder.ts')]);
      });
    });

    it('the same FormKey import inside the Plugins view is not caught — the walk still reaches it', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'mods'), { recursive: true });
        mkdirSync(join(root, 'plugins'), { recursive: true });
        const planted = "import type { FormKey } from '../medit/ApiClient';\n";
        writeFileSync(join(root, 'mods', 'ModListProvider.ts'), planted);
        writeFileSync(join(root, 'plugins', 'PluginTreeProvider.ts'), planted);
        const reached = tsFiles(root).map((p) => relative(root, p));
        expect(reached).toEqual(expect.arrayContaining([join('plugins', 'PluginTreeProvider.ts')]));
        expect(findOffenders(root).map((o) => o.path)).toEqual([join('mods', 'ModListProvider.ts')]);
      });
    });

    it('the same mEdit-client import inside Editing\'s own directory is not caught', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'mods'), { recursive: true });
        mkdirSync(join(root, 'medit'), { recursive: true });
        const planted = "import { ApiPluginRepository } from '../medit/PluginRepository';\n";
        writeFileSync(join(root, 'mods', 'ModListProvider.ts'), planted);
        writeFileSync(join(root, 'medit', 'EditingController.ts'), planted);
        expect(findOffenders(root).map((o) => o.path)).toEqual([join('mods', 'ModListProvider.ts')]);
      });
    });

    it('an Editor-folder import planted in a Mods-shaped file is caught', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'mods'), { recursive: true });
        writeFileSync(join(root, 'mods', 'ModListProvider.ts'), "import { ActiveRecordTracker } from '../editor/ActiveRecordTracker';\n");
        expect(findOffenders(root).map((o) => o.path)).toEqual([join('mods', 'ModListProvider.ts')]);
      });
    });

    it('the same Editor-folder import inside Editor\'s own directory is not caught', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'mods'), { recursive: true });
        mkdirSync(join(root, 'editor'), { recursive: true });
        const planted = "import { ActiveRecordTracker } from './ActiveRecordTracker';\n";
        writeFileSync(join(root, 'mods', 'ModListProvider.ts'), "import { ActiveRecordTracker } from '../editor/ActiveRecordTracker';\n");
        writeFileSync(join(root, 'editor', 'recordPanelHost.ts'), planted);
        expect(findOffenders(root).map((o) => o.path)).toEqual([join('mods', 'ModListProvider.ts')]);
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

describe('the Plugins view\'s failure prefix stays a decoration', () => {
  it('imports nothing but vscode', () => {
    expect(importsOf(read(join('plugins', 'failurePrefixIcon.ts')))).toEqual(['vscode']);
  });
});

describe('the driving lib\'s name filter imports from neither context', () => {
  it('imports nothing but vscode', () => {
    const imports = importsOf(read(join('drivingLib', 'nameFilter.ts')));
    expect(imports.filter((s) => s.includes('medit') || s.includes('mods') || s.includes('downloads'))).toEqual([]);
    expect(imports).toEqual(['vscode']);
  });
});

describe('composition-root modules import from neither context', () => {
  it('the editing teardown module imports from neither context', () => {
    const imports = importsOf(read('editingTeardown.ts'));
    expect(imports.filter((s) => s.includes('medit') || s.includes('mods') || s.includes('downloads'))).toEqual([]);
    expect(imports).toEqual(['vscode']);
  });

});

describe('the load-order sender belongs to Editing alone', () => {
  const SENDER = 'client/loadOrderSender.ts';

  it('imports nothing but its own port module', () => {
    expect(importsOf(read(SENDER))).toEqual(['./MEditClient']);
  });

  it('carries none of Mod Management\'s vocabulary', () => {
    const code = read(SENDER)
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect([...code.matchAll(/\b(mods?|modlists?|profiles?)\b/gi)].map((m) => m[0])).toEqual([]);
  });
});

function crossFolderOffenders(root: string, sourceDir: string, forbiddenDirs: string[]): { path: string; imports: string[] }[] {
  const base = join(root, sourceDir);
  let files: string[];
  try {
    files = tsFiles(base);
  } catch {
    return [];
  }
  const offenses: { path: string; imports: string[] }[] = [];
  for (const path of files) {
    const relPath = relative(root, path);
    if (isTestSupport(relPath)) continue;
    const imports = importsOf(readFileSync(path, 'utf8'));
    const forbidden = forbiddenDirs.flatMap((dir) => importsFromDir(imports, dir));
    if (forbidden.length > 0) offenses.push({ path: relPath, imports: forbidden });
  }
  return offenses;
}

describe('Editing imports nothing from Editor', () => {
  it('nothing under Editing imports from Editor', () => {
    expect(crossFolderOffenders(SRC, EDITING_DIR, [EDITOR_DIR])).toEqual([]);
  });

  describe('a plant is caught, and a sibling import beside it is not', () => {
    function withPlantedTree(run: (root: string) => void): void {
      const root = mkdtempSync(join(tmpdir(), 'medit-editing-editor-boundary-'));
      try {
        run(root);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    it('an Editor import planted in an Editing-shaped file is caught', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'medit'), { recursive: true });
        writeFileSync(join(root, 'medit', 'someModule.ts'), "import { ActiveRecordTracker } from '../editor/ActiveRecordTracker';\n");
        expect(crossFolderOffenders(root, EDITING_DIR, [EDITOR_DIR]).map((o) => o.path))
          .toEqual([join('medit', 'someModule.ts')]);
      });
    });

    it('an Editing file importing its own sibling is not caught alongside one that crosses to Editor', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'medit'), { recursive: true });
        writeFileSync(join(root, 'medit', 'someModule.ts'), "import { ActiveRecordTracker } from '../editor/ActiveRecordTracker';\n");
        writeFileSync(join(root, 'medit', 'otherModule.ts'), "import { pluginFailures } from './pluginFailures';\n");
        expect(crossFolderOffenders(root, EDITING_DIR, [EDITOR_DIR]).map((o) => o.path))
          .toEqual([join('medit', 'someModule.ts')]);
      });
    });
  });
});
