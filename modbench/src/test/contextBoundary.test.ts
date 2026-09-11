import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative, sep } from 'node:path';

// CONTEXT.md/ADR-0012: Mods, Downloads, Toolbox and the Instance key a plugin by filename and
// origin, never by FormKey, and never reach the backend. The Plugins view is excluded — it
// browses records by design.

const SRC = join(__dirname, '..');

const read = (relativePath: string) => readFileSync(join(SRC, relativePath), 'utf8');

function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:import|export)[\s\S]*?from\s+'([^']+)'/g)].map((m) => m[1]);
}

// No directory is skipped by name here, so the walk provably reaches the Plugins view;
// `isExcluded` decides what counts against the rule, not the walk.
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(path));
    else if (extname(entry.name) === '.ts' || extname(entry.name) === '.tsx') out.push(path);
  }
  return out;
}

const EDITING_DIR = 'medit';
const PLUGINS_VIEW_DIR = 'plugins';
const EDITOR_DIR = 'editor';
const MOD_MANAGEMENT_DIR = 'modmanager';
const GENERATED_DIR = 'generated';

// Wires every context together (CONTEXT.md calls the Toolbox also the extension's composition
// root). `toolboxClientCalls.ts` is toolbox.ts's own port calls, pulled out for testability —
// same rule.
const WIRES_EVERY_CONTEXT = ['toolbox.ts', 'toolboxClientCalls.ts', 'extension.ts'];

// Activation-scoped shared state: holds type-only handles into both contexts so other
// composition-root code can read them, but does not itself wire anything together.
const SHARED_ACTIVATION_STATE = ['session.ts'];

// Imports a non-FormKey utility (game-path autodetection) that happens to live under medit/,
// tripping the blunt medit-path check as a false positive.
const MEDIT_PATH_FALSE_POSITIVE = ['workspaceConfig.ts'];

// Wires a TreeView checkbox event to the Plugins view's own Mod-Management API
// (`setPluginEnabled`/`invalidate`) — composition-root glue carrying no record vocabulary.
const CHECKBOX_HANDLER_WIRING = ['pluginCheckboxHandler.ts'];

const COMPOSITION_ROOT =
  [...WIRES_EVERY_CONTEXT, ...SHARED_ACTIVATION_STATE, ...MEDIT_PATH_FALSE_POSITIVE, ...CHECKBOX_HANDLER_WIRING];

// Test names, descriptions and fixtures are prose and corpus data, never a decision.
function isTestSupport(relativePath: string): boolean {
  return relativePath.split(sep).some((seg) => seg === 'test' || seg === 'integration') || relativePath.includes('.test.');
}

// Every exclusion this scan makes, stated with its own reason.
function isExcluded(relativePath: string): boolean {
  const segments = relativePath.split(sep);
  if (segments.includes(GENERATED_DIR)) return true; // mirrors the backend's schema, not a decision
  if (segments[0] === PLUGINS_VIEW_DIR) return true; // a record browser by design
  if (segments[0] === EDITING_DIR) return true; // Editing's own context, not the MO2 side this rule binds
  if (segments[0] === EDITOR_DIR) return true; // Editor's own context — record vocabulary by design, same as Plugins
  if (COMPOSITION_ROOT.includes(relativePath)) return true; // each entry's own reason is stated above
  if (isTestSupport(relativePath)) return true; // prose and corpus, not a decision
  return false;
}

// TypeScript's own `Record<K, V>` utility type is excluded by the only syntax that can validly
// follow it: a generic argument list.
function domainVocabIn(text: string): string[] {
  const code = text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  return [...code.matchAll(/\b(records?|formkeys?|recordtypes?|editorids?)\b(?!\s*<)/gi)].map((m) => m[0]);
}

interface Offense { path: string; crossContext: string[]; vocab: string[] }

// A path segment, never a substring: `mo2/pluginsText` must not match `plugins` the way a blunt
// `.includes()` would.
function importsFromDir(imports: string[], dir: string): string[] {
  return imports.filter((s) => s.split('/').includes(dir));
}

// Shared by the production assertion and the self-tests below, so a broken traversal — the wrong
// root, a directory silently skipped — fails both the same way, not just the regexes.
function findOffenders(root: string): Offense[] {
  const offenses: Offense[] = [];
  for (const path of tsFiles(root)) {
    const relPath = relative(root, path);
    if (isExcluded(relPath)) continue;
    const text = readFileSync(path, 'utf8');
    const imports = importsOf(text);
    // Every context a MO2-side file must never reach into: Editing's client, the Plugins view's
    // record browser, and Editor — all carry record types and FormKeys just as directly.
    const crossContext = [
      ...importsFromDir(imports, EDITING_DIR), ...importsFromDir(imports, PLUGINS_VIEW_DIR),
      ...importsFromDir(imports, EDITOR_DIR),
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

  // The exclusion must be deliberate, not a gap in the walk's reach: first prove the raw walk
  // lists a Plugins-view file at all.
  it('the raw walk reaches the Plugins view', () => {
    const reached = tsFiles(SRC).map((p) => relative(SRC, p));
    expect(reached).toEqual(expect.arrayContaining([join('plugins', 'PluginsTreeProvider.ts'), join('plugins', 'PluginTreeProvider.ts')]));
  });

  // Then prove the exclusion is a named rule, not the walk missing the directory.
  it('the Plugins view is skipped by a stated exclusion', () => {
    expect(isExcluded(join('plugins', 'PluginsTreeProvider.ts'))).toBe(true);
    expect(isExcluded(join('plugins', 'PluginTreeProvider.ts'))).toBe(true);
  });

  it('the editor folder is skipped by a stated exclusion, the same as Plugins', () => {
    expect(isExcluded(join('editor', 'recordPanelHost.ts'))).toBe(true);
  });

  it('the generated API client is excluded because it mirrors the backend schema', () => {
    expect(isExcluded(join(EDITING_DIR, GENERATED_DIR, 'api.ts'))).toBe(true);
  });

  it('the composition-root allowlist is exactly these six files', () => {
    expect(COMPOSITION_ROOT.sort()).toEqual(
      ['extension.ts', 'pluginCheckboxHandler.ts', 'session.ts', 'toolbox.ts', 'toolboxClientCalls.ts', 'workspaceConfig.ts']);
  });

  // Each plant runs through the one shared findOffenders(), over a real temporary tree rather
  // than a hand-built string, so the walk itself is what's on test, not just the regex.
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
        mkdirSync(join(root, 'modmanager'), { recursive: true });
        writeFileSync(join(root, 'modmanager', 'ModListProvider.ts'), "import type { FormKey } from '../medit/ApiClient';\n");
        expect(findOffenders(root).map((o) => o.path)).toEqual([join('modmanager', 'ModListProvider.ts')]);
      });
    });

    it('an mEdit-client import planted in a Downloads-shaped file is caught', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'modmanager'), { recursive: true });
        writeFileSync(join(root, 'modmanager', 'DownloadsProvider.ts'), "import { ApiPluginRepository } from '../medit/PluginRepository';\n");
        expect(findOffenders(root).map((o) => o.path)).toEqual([join('modmanager', 'DownloadsProvider.ts')]);
      });
    });

    // The hole this closes: a Plugins-view import drags record types and the record browser into
    // the MO2 side exactly as a medit/ import would, and `.includes('medit')` alone never sees it.
    it('a Plugins-view import planted in a MO2-shaped file is caught', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'modmanager'), { recursive: true });
        writeFileSync(join(root, 'modmanager', 'ModListProvider.ts'), "import { ErrorNode } from '../plugins/PluginTreeProvider';\n");
        expect(findOffenders(root).map((o) => o.path)).toEqual([join('modmanager', 'ModListProvider.ts')]);
      });
    });

    // The rival this guards: matching `plugins` as a substring rather than a path segment would
    // also flag a genuinely MO2-side module whose name merely contains the word.
    it('an MO2-side module named pluginsText is not caught by the Plugins-view check', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'modmanager', 'mo2'), { recursive: true });
        writeFileSync(join(root, 'modmanager', 'mo2', 'pluginsText.ts'), 'export const x = 1;\n');
        writeFileSync(join(root, 'modmanager', 'ModListProvider.ts'), "import { parsePlugins } from './mo2/pluginsText';\n");
        expect(findOffenders(root)).toEqual([]);
      });
    });

    it('an mEdit-client import planted in the Instance file itself is caught, at its real nested depth', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'modmanager'), { recursive: true });
        writeFileSync(join(root, 'modmanager', 'instance.ts'), "import { EditingController } from '../medit/EditingController';\n");
        expect(findOffenders(root).map((o) => o.path)).toEqual([join('modmanager', 'instance.ts')]);
      });
    });

    it('a Toolbox-shaped file that imports the mEdit client is caught', () => {
      withPlantedTree((root) => {
        writeFileSync(join(root, 'ToolboxProvider.ts'), "import { ApiPluginRepository } from './medit/PluginRepository';\n");
        expect(findOffenders(root).map((o) => o.path)).toEqual(['ToolboxProvider.ts']);
      });
    });

    it('the same FormKey import inside the Plugins view is not caught — the walk still reaches it', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'modmanager'), { recursive: true });
        mkdirSync(join(root, 'plugins'), { recursive: true });
        const planted = "import type { FormKey } from '../medit/ApiClient';\n";
        writeFileSync(join(root, 'modmanager', 'ModListProvider.ts'), planted);
        writeFileSync(join(root, 'plugins', 'PluginTreeProvider.ts'), planted);
        const reached = tsFiles(root).map((p) => relative(root, p));
        expect(reached).toEqual(expect.arrayContaining([join('plugins', 'PluginTreeProvider.ts')]));
        expect(findOffenders(root).map((o) => o.path)).toEqual([join('modmanager', 'ModListProvider.ts')]);
      });
    });

    it('the same mEdit-client import inside Editing\'s own directory is not caught', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'modmanager'), { recursive: true });
        mkdirSync(join(root, 'medit'), { recursive: true });
        const planted = "import { ApiPluginRepository } from '../medit/PluginRepository';\n";
        writeFileSync(join(root, 'modmanager', 'ModListProvider.ts'), planted);
        writeFileSync(join(root, 'medit', 'EditingController.ts'), planted);
        expect(findOffenders(root).map((o) => o.path)).toEqual([join('modmanager', 'ModListProvider.ts')]);
      });
    });

    // Editor carries the same FormKey vocabulary and the same client the medit/ check already
    // guards against — a MO2-shaped file reaching it is exactly the violation this rule exists for.
    it('an Editor-folder import planted in a Mods-shaped file is caught', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'modmanager'), { recursive: true });
        writeFileSync(join(root, 'modmanager', 'ModListProvider.ts'), "import { ActiveRecordTracker } from '../editor/ActiveRecordTracker';\n");
        expect(findOffenders(root).map((o) => o.path)).toEqual([join('modmanager', 'ModListProvider.ts')]);
      });
    });

    it('the same Editor-folder import inside Editor\'s own directory is not caught', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'modmanager'), { recursive: true });
        mkdirSync(join(root, 'editor'), { recursive: true });
        const planted = "import { ActiveRecordTracker } from './ActiveRecordTracker';\n";
        writeFileSync(join(root, 'modmanager', 'ModListProvider.ts'), "import { ActiveRecordTracker } from '../editor/ActiveRecordTracker';\n");
        writeFileSync(join(root, 'editor', 'recordPanelHost.ts'), planted);
        expect(findOffenders(root).map((o) => o.path)).toEqual([join('modmanager', 'ModListProvider.ts')]);
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

// Held to the stricter "imports from neither context" bar: unlike Mods, Downloads, Toolbox and
// the Instance, these have no legitimate reason to import either side's vocabulary at all.
describe('composition-root modules import from neither context', () => {
  // The one shared presentation primitive both trees decorate with. It belongs to neither
  // context and must stay that way, or importing it would carry one context into the other.
  it('the shared failure prefix icon imports nothing but vscode', () => {
    expect(importsOf(read('failurePrefixIcon.ts'))).toEqual(['vscode']);
  });

  // The name filter serves views from both contexts, so it belongs to neither folder and lives
  // at the composition root; the same structural-deps check keeps that honest.
  it('the name filter imports from neither context', () => {
    const imports = importsOf(read('nameFilter.ts'));
    expect(imports.filter((s) => s.includes('medit') || s.includes('modmanager'))).toEqual([]);
    expect(imports).toEqual(['vscode']);
  });

  // ADR-0013: the sync is the one path by which Mod Management's snapshot reaches Editing.
  // Importing `LoadOrderPlugin` rather than keeping the snapshot opaque would be a one-word change
  // that quietly makes this module part of Mod Management.
  it('the load-order sync imports from neither context', () => {
    const imports = importsOf(read('loadOrderReconcile.ts'));
    expect(imports.filter((s) => s.includes('medit') || s.includes('modmanager'))).toEqual([]);
    expect(imports).toEqual([]);
  });

  // The teardown/refresh writers left extension.ts for a unit seam and claim the same
  // structural-deps property, so they are guarded the same way: nothing imported but `vscode`.
  it('the editing teardown module imports from neither context', () => {
    const imports = importsOf(read('editingTeardown.ts'));
    expect(imports.filter((s) => s.includes('medit') || s.includes('modmanager'))).toEqual([]);
    expect(imports).toEqual(['vscode']);
  });

  // The sync may speak of a snapshot and a receiver, but never of what a snapshot holds on Mod
  // Management's side, nor what a plugin contains on Editing's. Prose is exempt.
  it('the load-order sync\'s code carries neither context\'s vocabulary', () => {
    const code = read('loadOrderReconcile.ts')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect([...code.matchAll(/\b(mods?|modlists?)\b/gi)].map((m) => m[0])).toEqual([]);
    expect([...code.matchAll(/\b(records?|formkeys?|editorids?)\b/gi)].map((m) => m[0])).toEqual([]);
  });
});

// A path segment against every file under `sourceDir`, never a substring — the same rule
// `importsFromDir` states for the MO2-side scan above.
function crossFolderOffenders(root: string, sourceDir: string, forbiddenDirs: string[]): { path: string; imports: string[] }[] {
  const base = join(root, sourceDir);
  let files: string[];
  try {
    files = tsFiles(base);
  } catch {
    return []; // sourceDir absent from this planted tree
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

// The record lifecycle commands carry user-facing strings that legitimately name Mod
// Management's term for the user ("mod"), so recordLifecycleCommands.ts gets the import-only
// tier rather than a "no vocabulary in its own text" bar.
describe('Editor and the Plugins view import from neither each other', () => {
  it('nothing under Editor imports from the Plugins view or from Mod Management', () => {
    expect(crossFolderOffenders(SRC, EDITOR_DIR, [PLUGINS_VIEW_DIR, MOD_MANAGEMENT_DIR])).toEqual([]);
  });

  it('nothing under the Plugins view imports from Editor', () => {
    expect(crossFolderOffenders(SRC, PLUGINS_VIEW_DIR, [EDITOR_DIR])).toEqual([]);
  });

  // Editing sits below Editor in the dependency direction (Editor imports the client, never the
  // reverse): a medit/ file reaching into editor/ would cycle the two.
  it('nothing under Editing imports from Editor', () => {
    expect(crossFolderOffenders(SRC, EDITING_DIR, [EDITOR_DIR])).toEqual([]);
  });

  describe('a plant in each direction is caught, and the same plant inside its own side is not', () => {
    function withPlantedTree(run: (root: string) => void): void {
      const root = mkdtempSync(join(tmpdir(), 'medit-editor-plugins-boundary-'));
      try {
        run(root);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    it('a Plugins-view import planted in an Editor-shaped file is caught', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'editor'), { recursive: true });
        writeFileSync(join(root, 'editor', 'someCommand.ts'), "import type { RecordNode } from '../plugins/PluginTreeProvider';\n");
        expect(crossFolderOffenders(root, EDITOR_DIR, [PLUGINS_VIEW_DIR, MOD_MANAGEMENT_DIR]).map((o) => o.path))
          .toEqual([join('editor', 'someCommand.ts')]);
      });
    });

    it('a Mod-Management import planted in an Editor-shaped file is caught', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'editor'), { recursive: true });
        writeFileSync(join(root, 'editor', 'someCommand.ts'), "import { Instance } from '../modmanager/instance';\n");
        expect(crossFolderOffenders(root, EDITOR_DIR, [PLUGINS_VIEW_DIR, MOD_MANAGEMENT_DIR]).map((o) => o.path))
          .toEqual([join('editor', 'someCommand.ts')]);
      });
    });

    it('an Editor import planted in a Plugins-shaped file is caught', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'plugins'), { recursive: true });
        writeFileSync(join(root, 'plugins', 'SomeProvider.ts'), "import { ActiveRecordTracker } from '../editor/ActiveRecordTracker';\n");
        expect(crossFolderOffenders(root, PLUGINS_VIEW_DIR, [EDITOR_DIR]).map((o) => o.path))
          .toEqual([join('plugins', 'SomeProvider.ts')]);
      });
    });

    it('an Editor import planted in an Editing-shaped file is caught', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'medit'), { recursive: true });
        writeFileSync(join(root, 'medit', 'someModule.ts'), "import { ActiveRecordTracker } from '../editor/ActiveRecordTracker';\n");
        expect(crossFolderOffenders(root, EDITING_DIR, [EDITOR_DIR]).map((o) => o.path))
          .toEqual([join('medit', 'someModule.ts')]);
      });
    });

    // The "own side" negative control for this direction: a Plugins-shaped file whose import
    // merely stays inside its own folder must not be caught alongside the one that crosses over.
    it('a Plugins-view file importing its own sibling is not caught alongside one that crosses to Editor', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'plugins'), { recursive: true });
        writeFileSync(join(root, 'plugins', 'SomeProvider.ts'), "import { ActiveRecordTracker } from '../editor/ActiveRecordTracker';\n");
        writeFileSync(join(root, 'plugins', 'OtherProvider.ts'), "import { PluginTreeNode } from './PluginTreeProvider';\n");
        expect(crossFolderOffenders(root, PLUGINS_VIEW_DIR, [EDITOR_DIR]).map((o) => o.path))
          .toEqual([join('plugins', 'SomeProvider.ts')]);
      });
    });
  });

  it('recordLifecycleCommands.ts imports nothing from Mod Management', () => {
    expect(importsOf(read('editor/recordLifecycleCommands.ts')).filter((s) => s.includes('modmanager'))).toEqual([]);
  });
});
