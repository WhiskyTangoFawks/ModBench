import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { present } from '../ports/present';
import { tsFiles } from './tsFiles';

// CONTEXT.md/ADR-0012: Mods, Downloads, Toolbox and the Instance key a plugin by filename and
// origin, never by FormKey, and never reach the backend. The Plugins view is excluded — it
// browses records by design.

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
  if (segments[0] === WIRE_DIR) return true; // the kernel's wire protocol, generated or transcribed, not a decision
  if (segments[0] === PLUGINS_VIEW_DIR) return true; // a record browser by design
  if (segments[0] === EDITING_DIR) return true; // Editing's own context, not the MO2 side this rule binds
  if (segments[0] === CLIENT_DIR) return true; // the seam Editing speaks through — the backend's own vocabulary
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
      ...importsFromDir(imports, EDITING_DIR), ...importsFromDir(imports, CLIENT_DIR),
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
    expect(isExcluded(join(WIRE_DIR, GENERATED_DIR, 'api.ts'))).toBe(true);
  });

  // The webview message protocol names a record and a FormKey because that is what crosses the
  // wire; it decides nothing, the same as the schema beside it.
  it('the wire box is excluded, protocol and schema alike', () => {
    expect(isExcluded(join(WIRE_DIR, 'messages.ts'))).toBe(true);
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

    // The hole this closes: a Plugins-view import drags record types and the record browser into
    // the MO2 side exactly as a medit/ import would, and `.includes('medit')` alone never sees it.
    it('a Plugins-view import planted in a MO2-shaped file is caught', () => {
      withPlantedTree((root) => {
        mkdirSync(join(root, 'mods'), { recursive: true });
        writeFileSync(join(root, 'mods', 'ModListProvider.ts'), "import { ErrorNode } from '../plugins/PluginTreeProvider';\n");
        expect(findOffenders(root).map((o) => o.path)).toEqual([join('mods', 'ModListProvider.ts')]);
      });
    });

    // The rival this guards: matching `plugins` as a substring rather than a path segment would
    // also flag a genuinely MO2-side module whose name merely contains the word.
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
        writeFileSync(join(root, 'ToolboxProvider.ts'), "import { ApiPluginRepository } from './medit/PluginRepository';\n");
        expect(findOffenders(root).map((o) => o.path)).toEqual(['ToolboxProvider.ts']);
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

    // Editor carries the same FormKey vocabulary and the same client the medit/ check already
    // guards against — a MO2-shaped file reaching it is exactly the violation this rule exists for.
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

// A decoration primitive reaching for a client or a record type would carry the record browser
// into every row it touches.
describe('the Plugins view\'s failure prefix stays a decoration', () => {
  it('imports nothing but vscode', () => {
    expect(importsOf(read(join('plugins', 'failurePrefixIcon.ts')))).toEqual(['vscode']);
  });
});

// Held to the stricter "imports from neither context" bar: unlike Mods, Downloads, Toolbox and
// the Instance, these have no reason to import either side's vocabulary at all.
describe('composition-root modules import from neither context', () => {
  // The name filter serves views from both contexts, so it belongs to neither folder and lives
  // at the composition root; the same structural-deps check keeps that honest.
  it('the name filter imports from neither context', () => {
    const imports = importsOf(read('nameFilter.ts'));
    expect(imports.filter((s) => s.includes('medit') || s.includes('mods') || s.includes('downloads'))).toEqual([]);
    expect(imports).toEqual(['vscode']);
  });

  // The teardown/refresh writers left extension.ts for a unit seam and claim the same
  // structural-deps property, so they are guarded the same way: nothing imported but `vscode`.
  it('the editing teardown module imports from neither context', () => {
    const imports = importsOf(read('editingTeardown.ts'));
    expect(imports.filter((s) => s.includes('medit') || s.includes('mods') || s.includes('downloads'))).toEqual([]);
    expect(imports).toEqual(['vscode']);
  });

});

// ADR-0013: the client's sender is the one path by which Mod Management's snapshot reaches
// Editing. It restates the snapshot's shape rather than importing it, so the arrow carries a
// value and not a dependency.
describe('the load-order sender belongs to Editing alone', () => {
  const SENDER = 'client/loadOrderSender.ts';

  it('imports nothing but its own port module', () => {
    expect(importsOf(read(SENDER))).toEqual(['./MEditClient']);
  });

  // It may speak of a snapshot and its copies, but never of what a snapshot holds on Mod
  // Management's side — importing `LoadOrderPlugin` would be that one-word change. Prose is exempt.
  it('carries none of Mod Management\'s vocabulary', () => {
    const code = read(SENDER)
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect([...code.matchAll(/\b(mods?|modlists?|profiles?)\b/gi)].map((m) => m[0])).toEqual([]);
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

// Editor, Plugins, Mods, Downloads and the Instance are boxes whose reference lists never reach
// each other, so `tsc -b` refuses those imports. Editing's wiring compiles in the composition
// root, which references everything, so this scan holds it.
describe('Editing imports nothing from Editor', () => {
  // Editing sits below Editor in the dependency direction (Editor imports the client, never the
  // reverse): a medit/ file reaching into editor/ would cycle the two.
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

    // The "own side" negative control: an Editing-shaped file whose import merely stays inside
    // its own folder must not be caught alongside the one that crosses over.
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
