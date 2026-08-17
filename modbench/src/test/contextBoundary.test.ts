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

  // #255: the name filter serves views from both contexts (Mods, the merged Plugins tree,
  // Downloads), so like the composite it belongs to neither folder and lives at the composition
  // root. What makes that placement honest is the same property, so it is checked the same way:
  // structural deps, and nothing imported but `vscode`. Its own docstring cites this test — a
  // comment naming a guard that isn't guarding is worse than no comment, because it is trusted.
  it('the name filter imports from neither context', () => {
    const imports = importsOf(read('nameFilter.ts'));
    expect(imports.filter((s) => s.includes('medit') || s.includes('modmanager'))).toEqual([]);
    expect(imports).toEqual(['vscode']);
  });

  // #279: drift is a comparison between the session's loaded origin and Mod Management's current
  // one, so the tracker sits at the composition root for the same reason the two above do — and is
  // held to the same rule. The temptation here is specific and worth naming: `ResolvedOrigin` is
  // *declared* in `modmanager/explicitSession.ts`, and importing that type rather than restating
  // it structurally would be a one-word change that quietly makes this module part of Mod
  // Management.
  it('the drift tracker imports from neither context', () => {
    const imports = importsOf(read('pluginDrift.ts'));
    expect(imports.filter((s) => s.includes('medit') || s.includes('modmanager'))).toEqual([]);
    expect(imports).toEqual(['vscode']);
  });

  // Drift joins the two contexts, so it may name an *origin* — an opaque string on both sides
  // (ADR-0036) — but never what an origin is on Mod Management's side, and never what a plugin
  // contains on Editing's. "This plugin now comes from a different mod" is the sentence this
  // file's code must not be able to write. Prose is exempt for the same reason the composite is
  // exempt from this scan entirely: a joining module has to be able to say in words what it joins.
  it('the drift tracker\'s code carries neither context\'s vocabulary', () => {
    const code = read('pluginDrift.ts')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect([...code.matchAll(/\b(mods?|modlists?|loadouts?)\b/gi)].map((m) => m[0])).toEqual([]);
    expect([...code.matchAll(/\b(records?|formkeys?|editorids?)\b/gi)].map((m) => m[0])).toEqual([]);
  });

  it('the row provider contains no record vocabulary', () => {
    // #276: "immutable"/"read-only" pinned alongside the original record vocabulary — Editing's
    // "Immutable plugin" (read-only-for-editing) is a distinct concept from this row's own
    // "can't be toggled or moved" facts (the lock, #276/ADR-0035) and must stay decided and named
    // on the Editing/composite side (PluginsTreeComposite.ts, deliberately exempted from this
    // scan), never here. Bare `readonly` is excluded — it's a TypeScript keyword this file uses
    // throughout for unrelated reasons, not the domain term.
    const offending = [...read('modmanager/PluginListProvider.ts').matchAll(/\b(records?|formkeys?|recordtypes?|editorids?|immutable|read-only)\b/gi)];
    expect(offending.map((m) => m[0])).toEqual([]);
  });

  it('the child provider contains no mod vocabulary', () => {
    // Word-bounded so `model`, `modbench` and `modified` don't read as the domain term.
    const offending = [...read('medit/PluginTreeProvider.ts').matchAll(/\b(mods?|modlists?|loadouts?)\b/gi)];
    expect(offending.map((m) => m[0])).toEqual([]);
  });
});
