import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #270 / ADR-0035. The merged Plugins tree is one view fed by two bounded contexts, and the whole
// reason ADR-0027 could be amended rather than overridden is that the merge is structural: Mod
// Management owns the rows, Editing owns the children, and neither imports the other's vocabulary.
// That is an invariant about source text, so it is checked as one — a reviewer reading a diff that
// touches one provider has no reason to notice a term arriving from the other context, which is
// exactly why #270 was flagged as needing a developer in the loop rather than a checklist.
//
// The composite itself is deliberately not scanned: it is the composition root's join and has to
// be able to say in prose what it joins, the same way LoadoutHeaderProvider does. What it must not
// do is *import* from either side, which is asserted below.

const SRC = join(__dirname, '..');
const read = (relativePath: string) => readFileSync(join(SRC, relativePath), 'utf8');

/** Every module specifier in an import/export-from statement. */
function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:import|export)[\s\S]*?from\s+'([^']+)'/g)].map((m) => m[1]);
}

describe('bounded-context boundary in the merged Plugins tree', () => {
  it('the row provider imports nothing from Editing', () => {
    expect(importsOf(read('modmanager/PluginListProvider.ts')).filter((s) => s.includes('medit'))).toEqual([]);
  });

  it('the child provider imports nothing from Mod Management', () => {
    expect(importsOf(read('medit/PluginTreeProvider.ts')).filter((s) => s.includes('modmanager'))).toEqual([]);
  });

  it('the composite imports from neither context', () => {
    const imports = importsOf(read('PluginsTreeComposite.ts'));
    expect(imports.filter((s) => s.includes('medit') || s.includes('modmanager'))).toEqual([]);
    expect(imports).toEqual(['vscode']);
  });

  it('the row provider contains no record vocabulary', () => {
    const offending = [...read('modmanager/PluginListProvider.ts').matchAll(/\b(records?|formkeys?|recordtypes?|editorids?)\b/gi)];
    expect(offending.map((m) => m[0])).toEqual([]);
  });

  it('the child provider contains no mod vocabulary', () => {
    // Word-bounded so `model`, `modbench` and `modified` don't read as the domain term.
    const offending = [...read('medit/PluginTreeProvider.ts').matchAll(/\b(mods?|modlists?|loadouts?)\b/gi)];
    expect(offending.map((m) => m[0])).toEqual([]);
  });
});
