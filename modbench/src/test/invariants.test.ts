import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { present } from '../ports/present';
import { productionFiles, SRC } from './scanSource';
import { tsFiles } from './tsFiles';
const read = (relativePath: string) => readFileSync(join(SRC, relativePath), 'utf8');

describe('every MO2 text-file write command has a corpus test', () => {
  const WRITERS = [
    'downloadedFileCommands/downloads.ts', 'modCommands/install.ts', 'modCommands/modCommands.ts',
    'pluginCommands/plugins.ts', 'instanceCommands/instanceCommands.ts',
  ];
  const writeVerbs = WRITERS.flatMap((file) => commandVerbs(read(file)));
  const corpus = tsFiles(SRC, { exclude: ['generated'] }).filter((f) => f.endsWith('Corpus.test.ts')).map((f) => readFileSync(f, 'utf8')).join('\n');

  it('finds the write verbs', () => {
    for (const verb of [
      'setModsEnabled', 'moveMods', 'moveSeparators', 'markFiles', 'insertSeparator', 'renameSeparator',
      'deleteSeparators', 'uninstallMods', 'createEmptyMod', 'renameMod',
    ]) expect(writeVerbs).toContain(verb);
    expect(writeVerbs).toContain('switchProfile');
    expect(writeVerbs).not.toContain('refresh');
    for (const verb of ['setPluginsParticipation', 'setPluginsEnabled', 'reorderPlugins']) expect(writeVerbs).toContain(verb);
    expect(writeVerbs).toContain('excludeDownloads');
    expect(writeVerbs).toContain('includeDownloads');
    expect(writeVerbs).toContain('modSyncOver');
    expect(writeVerbs).toContain('pluginSyncOver');
    expect(writeVerbs).toContain('deleteDownloads');
    expect(writeVerbs).toContain('installMod');
  });

  it.each(writeVerbs)('%s', (verb) => {
    expect(corpus).toMatch(new RegExp(`\\b${verb}\\(`));
  });
});

describe('only the Instance adapter touches a downloaded file\'s .meta', () => {
  const importsTheSidecarPath = (source: string): boolean =>
    [...source.matchAll(/import\s*\{([^}]*)\}\s*from/g)].some((m) => /\bdownloadSidecarFile\b/.test(m[1] ?? ''));

  it('sees the sidecar path among an import\'s names, the form any other touch of the .meta takes', () => {
    expect(importsTheSidecarPath("import { downloadFile, downloadSidecarFile } from '../instanceAdapter/layout';")).toBe(true);
    expect(importsTheSidecarPath("import {\n  downloadSidecarFile,\n} from './layout';")).toBe(true);
    expect(importsTheSidecarPath("import { downloadFile } from '../instanceAdapter/layout';")).toBe(false);
  });

  it('is imported nowhere outside the Instance adapter', () => {
    const offenders = sourceFiles().filter((f) => !f.startsWith('instanceAdapter/') && importsTheSidecarPath(read(f)));
    expect(offenders).toEqual([]);
  });
});

function commandVerbs(source: string): string[] {
  const bound = new Set([...source.matchAll(/TailOf<typeof (\w+)>/g)].map((m) => m[1]));
  return [...source.matchAll(/^(export )?(?:async )?function (\w+)([\s\S]*?)\{\n/gm)]
    .filter((m) => /InstanceAdapter|SourceModWriters/.test(present(m[3], "the signature")))
    .filter((m) => m[1] !== undefined || bound.has(m[2]))
    .filter((m) => /applied|Result[<>]|SelectionOutcome<|Run\s*$/.test(present(m[3], "the function body between signature and opening brace")))
    .map((m) => present(m[2], "the function's name"));
}

describe('the createTreeView sites', () => {
  const ids = viewIdConstants();
  const sites = sourceFiles().flatMap((f) => treeViewOptions(read(f))).map((s) => ({ ...s, id: ids.get(s.id) ?? s.id }));

  it('reads every createTreeView site', () => {
    expect(sites.map((s) => s.id).sort()).toEqual([
      'modbench.downloads', 'modbench.modList', 'modbench.pluginListTree', 'modbench.toolbox',
    ]);
  });

  it('collapse-all views are the trees: Mods and the merged Plugins tree', () => {
    const collapsible = new Set(sites.filter((s) => /showCollapseAll:\s*true/.test(s.options)).map((s) => s.id));
    expect([...collapsible].sort()).toEqual(['modbench.modList', 'modbench.pluginListTree']);
  });

  it('every view but the Toolbox selects several rows', () => {
    const singleSelect = sites.filter((s) => !/canSelectMany:\s*true/.test(s.options)).map((s) => s.id);
    expect(singleSelect).toEqual(['modbench.toolbox']);
  });

  it('the site reader sees through nested braces to the whole options object', () => {
    const source = "createTreeView('a.b', { treeDataProvider: p, dragAndDropController: { x: {} }, showCollapseAll: true });";
    expect(treeViewOptions(source)).toEqual([{ id: 'a.b', options: " treeDataProvider: p, dragAndDropController: { x: {} }, showCollapseAll: true " }]);
  });
});

function sourceFiles(): string[] {
  return productionFiles(SRC).map((f) => relative(SRC, f).split(sep).join('/'));
}

/** A view's id is declared once, beside the view: `NAME = 'id'` or `NAME = { view: 'id' }`, read as `NAME` or `NAME.view`. */
function viewIdConstants(): Map<string, string> {
  const ids = new Map<string, string>();
  for (const file of sourceFiles()) {
    for (const m of read(file).matchAll(/\b(\w+)\s*=\s*(?:\{\s*view:\s*)?'(modbench\.\w+)'/g)) {
      ids.set(`${m[1]}${m[0].includes('view:') ? '.view' : ''}`, present(m[2], 'the view id'));
    }
  }
  return ids;
}

function treeViewOptions(source: string): { id: string; options: string }[] {
  const out: { id: string; options: string }[] = [];
  for (const m of source.matchAll(/createTreeView\(([\w.']+),\s*\{/g)) {
    const start = m.index + m[0].length;
    let depth = 1;
    let end = start;
    while (depth > 0 && end < source.length) {
      if (source[end] === '{') depth++;
      else if (source[end] === '}') depth--;
      end++;
    }
    out.push({ id: present(m[1], "the createTreeView call's id argument").replaceAll("'", ''), options: source.slice(start, end - 1) });
  }
  return out;
}

