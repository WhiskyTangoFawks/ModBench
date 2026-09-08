import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Rules a compiling change can break silently, checked as source text like contextBoundary.test.ts.

const SRC = join(__dirname, '..');
const read = (relativePath: string) => readFileSync(join(SRC, relativePath), 'utf8');

// ADR-0021: a write verb is a surgical edit of one MO2 file, and the corpus tests are what prove
// it touched nothing else. A verb without one is unproven.
describe('every Mo2ModlistSource write verb has a corpus test', () => {
  const writeVerbs = [...read('modmanager/mo2/Mo2ModlistSource.ts').matchAll(/^ {2}async (?!read|list|get)(\w+)\(/gm)].map((m) => m[1]);
  const corpusDir = join(SRC, 'modmanager');
  const corpus = walk(corpusDir).filter((f) => f.endsWith('Corpus.test.ts')).map((f) => readFileSync(f, 'utf8')).join('\n');

  it('finds the write verbs', () => {
    expect(writeVerbs).toContain('setEnabled');
    expect(writeVerbs).not.toContain('readModlist');
  });

  it.each(writeVerbs)('%s', (verb) => {
    expect(corpus).toMatch(new RegExp(`\\b${verb}\\(`));
  });
});

// docs/specs/containers.md rule 7: showCollapseAll on every hierarchical tree, never a flat
// list. `createTreeView` has no declarative contribution, so the call sites are the seam.
describe('title-bar rule 7: showCollapseAll marks exactly the hierarchical trees', () => {
  const sites = sourceFiles().flatMap((f) => treeViewOptions(read(f)));

  it('reads every createTreeView site', () => {
    expect(sites.map((s) => s.id).sort()).toEqual([
      'modbench.downloads', 'modbench.loadoutHeader', 'modbench.modList', 'modbench.modList',
      'modbench.pluginListTree', 'modbench.referencedByTree',
    ]);
  });

  it('collapse-all views are the Mods tree and the merged Plugins tree', () => {
    const collapsible = new Set(sites.filter((s) => /showCollapseAll:\s*true/.test(s.options)).map((s) => s.id));
    expect([...collapsible].sort()).toEqual(['modbench.modList', 'modbench.pluginListTree']);
  });

  it('the site reader sees through nested braces to the whole options object', () => {
    const source = "createTreeView('a.b', { treeDataProvider: p, dragAndDropController: { x: {} }, showCollapseAll: true });";
    expect(treeViewOptions(source)).toEqual([{ id: 'a.b', options: " treeDataProvider: p, dragAndDropController: { x: {} }, showCollapseAll: true " }]);
  });
});

// ADR-0035: read-only-for-editing is a tooltip; a contextValue for it would grow a second menu.
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
    out.push({ id: m[1], options: source.slice(start, end - 1) });
  }
  return out;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    return d.isDirectory() ? (d.name === 'generated' ? [] : walk(p)) : [p];
  });
}
