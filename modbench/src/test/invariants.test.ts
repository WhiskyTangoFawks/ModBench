import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { present } from '../ports/present';

// Rules a compiling change can break silently, checked as source text like contextBoundary.test.ts.

const SRC = join(__dirname, '..');
const read = (relativePath: string) => readFileSync(join(SRC, relativePath), 'utf8');

// ADR-0017: a write verb is a surgical edit of one MO2 text file, and the corpus tests are what
// prove it touched nothing else. A verb without one is unproven.
describe('every MO2 text-file write command has a corpus test', () => {
  const WRITERS = [
    'install/downloadSidecar.ts', 'modlist/modlist.ts',
    'pluginsCommands/plugins.ts', 'instanceCommands/profile.ts',
  ];
  const writeVerbs = WRITERS.flatMap((file) => commandVerbs(read(file)));
  const corpus = walk(SRC).filter((f) => f.endsWith('Corpus.test.ts')).map((f) => readFileSync(f, 'utf8')).join('\n');

  it('finds the write verbs', () => {
    expect(writeVerbs).toContain('setModEnabled');
    expect(writeVerbs).toContain('switchProfile');
    expect(writeVerbs).toContain('hideDownload');
    expect(writeVerbs).toContain('deleteDownloads');
  });

  it.each(writeVerbs)('%s', (verb) => {
    expect(corpus).toMatch(new RegExp(`\\b${verb}\\(`));
  });
});

// A verb is an exported function whose signature answers with a result — `applied` inline, one
// of the named `…Result` types every gesture returns (ADR-0015 invariant 2), or a selection's
// outcome.
function commandVerbs(source: string): string[] {
  return [...source.matchAll(/^export (?:async )?function (\w+)([\s\S]*?)\{\n/gm)]
    .filter((m) => /applied|Result>|SelectionOutcome</.test(present(m[2], "the function body between signature and opening brace")))
    .map((m) => present(m[1], "the exported function's name"));
}

// `createTreeView` has no declarative contribution, so the call sites are the seam for a tree's
// options.
describe('the createTreeView sites', () => {
  const sites = sourceFiles().flatMap((f) => treeViewOptions(read(f)));

  it('reads every createTreeView site', () => {
    expect(sites.map((s) => s.id).sort()).toEqual([
      'modbench.downloads', 'modbench.modList', 'modbench.pluginListTree',
      'modbench.referencedByTree', 'modbench.toolbox',
    ]);
  });

  // docs/specs/containers.md rule 7: showCollapseAll on every hierarchical tree, never a flat list.
  it('collapse-all views are the Mods tree and the merged Plugins tree', () => {
    const collapsible = new Set(sites.filter((s) => /showCollapseAll:\s*true/.test(s.options)).map((s) => s.id));
    expect([...collapsible].sort()).toEqual(['modbench.modList', 'modbench.pluginListTree']);
  });

  // common.md, A view, story 6: every list selects several rows. The Toolbox is a readout, where
  // selecting several rows means nothing (toolbox.md).
  it('every view but the Toolbox selects several rows', () => {
    const singleSelect = sites.filter((s) => !/canSelectMany:\s*true/.test(s.options)).map((s) => s.id);
    expect(singleSelect).toEqual(['modbench.toolbox']);
  });

  it('the site reader sees through nested braces to the whole options object', () => {
    const source = "createTreeView('a.b', { treeDataProvider: p, dragAndDropController: { x: {} }, showCollapseAll: true });";
    expect(treeViewOptions(source)).toEqual([{ id: 'a.b', options: " treeDataProvider: p, dragAndDropController: { x: {} }, showCollapseAll: true " }]);
  });
});

// ADR-0017: read-only-for-editing is a tooltip; a contextValue for it would grow a second menu.
describe('no contextValue encodes read-only', () => {
  it.each(sourceFiles())('%s', (file) => {
    expect(readOnlyContextValues(read(file))).toEqual([]);
  });

  it('the scan flags an assignment and ignores prose', () => {
    expect(readOnlyContextValues("this.contextValue = 'recordReadOnly';\n// a read-only contextValue would be wrong\n"))
      .toEqual(["this.contextValue = 'recordReadOnly';"]);
  });
});

function readOnlyContextValues(source: string): string[] {
  return source.split('\n').filter((l) => /contextValue/.test(l) && /read[-_ ]?only/i.test(l) && !/^\s*\/\//.test(l));
}

function sourceFiles(): string[] {
  return walk(SRC).filter((f) => f.endsWith('.ts') && !f.includes('.test.') && !f.includes('/test/')).map((f) => f.slice(SRC.length + 1));
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

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    return d.isDirectory() ? (d.name === 'generated' ? [] : walk(p)) : [p];
  });
}

// ADR-0019 invariant 3: surfacing goes through the injected reporter and the dialog. Anywhere
// but the two adapter modules, a raw window message call is a surface no test can read.
describe('the message APIs live only in the reporter and the dialog', () => {
  it('exactly the two adapters call one', () => {
    expect(sourceFiles().filter((file) => messageApiCalls(read(file)).length > 0).sort())
      .toEqual(['dialog.ts', 'reporter.ts']);
  });

  // Rivals this catches: a module toasting directly, and one aliasing `vscode.window` first.
  it('flags a raw call wherever it is planted', () => {
    expect(messageApiCalls("void vscode.window.showWarningMessage('careful');")).toEqual(['showWarningMessage']);
    expect(messageApiCalls("const { showErrorMessage } = vscode.window;")).toEqual(['showErrorMessage']);
    expect(messageApiCalls("reporter.report('warning', 'careful');")).toEqual([]);
  });
});

function messageApiCalls(source: string): string[] {
  return [...source.matchAll(/show(?:Information|Warning|Error)Message/g)].map((m) => m[0]);
}
