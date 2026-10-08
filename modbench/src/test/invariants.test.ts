import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { present } from '../ports/present';
import { productionFiles, SRC } from './scanSource';
import { tsFiles } from './tsFiles';
const read = (relativePath: string) => readFileSync(join(SRC, relativePath), 'utf8');

describe('every MO2 text-file write command has a corpus test', () => {
  const WRITERS = [
    'downloadsCommands/downloads.ts', 'install/installedMark.ts', 'modlist/modlist.ts',
    'pluginsCommands/plugins.ts', 'instanceCommands/profile.ts',
  ];
  const writeVerbs = WRITERS.flatMap((file) => commandVerbs(read(file)));
  const corpus = tsFiles(SRC, { exclude: ['generated'] }).filter((f) => f.endsWith('Corpus.test.ts')).map((f) => readFileSync(f, 'utf8')).join('\n');

  it('finds the write verbs', () => {
    expect(writeVerbs).toContain('setModsEnabled');
    expect(writeVerbs).toContain('switchProfile');
    expect(writeVerbs).toContain('excludeDownloads');
    expect(writeVerbs).toContain('modSyncOver');
    expect(writeVerbs).toContain('pluginSyncOver');
    expect(writeVerbs).toContain('deleteDownloads');
    expect(writeVerbs).toContain('markDownloadInstalled');
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
  return [...source.matchAll(/^export (?:async )?function (\w+)([\s\S]*?)\{\n/gm)]
    .filter((m) => /applied|Result[<>]|SelectionOutcome<|Run\s*$/.test(present(m[2], "the function body between signature and opening brace")))
    .map((m) => present(m[1], "the exported function's name"));
}

describe('the createTreeView sites', () => {
  const sites = sourceFiles().flatMap((f) => treeViewOptions(read(f)));

  it('reads every createTreeView site', () => {
    expect(sites.map((s) => s.id).sort()).toEqual([
      'modbench.downloads', 'modbench.modList', 'modbench.pluginListTree',
      'modbench.referencedByTree', 'modbench.toolbox',
    ]);
  });

  it('collapse-all views are the trees: Mods, the merged Plugins tree and Referenced By', () => {
    const collapsible = new Set(sites.filter((s) => /showCollapseAll:\s*true/.test(s.options)).map((s) => s.id));
    expect([...collapsible].sort()).toEqual(['modbench.modList', 'modbench.pluginListTree', 'modbench.referencedByTree']);
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
  return productionFiles(SRC).map((f) => relative(SRC, f));
}

function treeViewOptions(source: string): { id: string; options: string }[] {
  const out: { id: string; options: string }[] = [];
  for (const m of source.matchAll(/createTreeView\('([\w.]+)',\s*\{/g)) {
    const start = m.index + m[0].length;
    let depth = 1;
    let end = start;
    while (depth > 0 && end < source.length) {
      if (source[end] === '{') depth++;
      else if (source[end] === '}') depth--;
      end++;
    }
    out.push({ id: present(m[1], "the createTreeView call's id argument"), options: source.slice(start, end - 1) });
  }
  return out;
}

