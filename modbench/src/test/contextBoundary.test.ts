import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ADR-0035: the merge is structural — Mod Management owns the rows, Editing the children.
// The boundary is an invariant about source text, so it is checked as one.

const SRC = join(__dirname, '..');
const read = (relativePath: string) => readFileSync(join(SRC, relativePath), 'utf8');

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

  // The name filter serves views from both contexts, so like the composite it belongs to neither
  // folder and lives at the composition root; the same structural-deps check keeps that honest.
  it('the name filter imports from neither context', () => {
    const imports = importsOf(read('nameFilter.ts'));
    expect(imports.filter((s) => s.includes('medit') || s.includes('modmanager'))).toEqual([]);
    expect(imports).toEqual(['vscode']);
  });

  // ADR-0044: the sync is the one path by which Mod Management's snapshot reaches Editing.
  // Importing `LoadOrderPlugin` rather than keeping the snapshot opaque would be a one-word change
  // that quietly makes this module part of Mod Management.
  it('the load-order sync imports from neither context', () => {
    const imports = importsOf(read('loadOrderReconcile.ts'));
    expect(imports.filter((s) => s.includes('medit') || s.includes('modmanager'))).toEqual([]);
    expect(imports).toEqual([]);
  });

  // The teardown/refresh writers left extension.ts for a unit seam and claim the same
  // structural-deps property, so they are guarded the same way: nothing imported but `vscode`.
  it('the loadout teardown module imports from neither context', () => {
    const imports = importsOf(read('loadoutTeardown.ts'));
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
    expect([...code.matchAll(/\b(mods?|modlists?|loadouts?)\b/gi)].map((m) => m[0])).toEqual([]);
    expect([...code.matchAll(/\b(records?|formkeys?|editorids?)\b/gi)].map((m) => m[0])).toEqual([]);
  });

  // `wirePluginListInvalidation` is deliberately typed against `{ invalidate: () => void }` rather
  // than the real `PluginListProvider`, so it never imports Mod Management's vocabulary; it is not
  // held to the vocabulary scan, being wiring rather than a joiner of both contexts.
  it('the plugin-list invalidation wiring imports from neither context', () => {
    const imports = importsOf(read('wirePluginListInvalidation.ts'));
    expect(imports.filter((s) => s.includes('medit') || s.includes('modmanager'))).toEqual([]);
    expect(imports).toEqual([]);
  });

  // Plain modmanager/ modules reachable from the composition root: held to the same "imports
  // nothing from Editing" bar PluginListProvider gets, not the stricter "nothing but vscode" one,
  // since these have real modmanager-internal dependencies.
  it('pluginDestination.ts imports nothing from Editing', () => {
    expect(importsOf(read('modmanager/pluginDestination.ts')).filter((s) => s.includes('medit'))).toEqual([]);
  });

  it('Mo2ModlistSource.ts imports nothing from Editing', () => {
    expect(importsOf(read('modmanager/mo2/Mo2ModlistSource.ts')).filter((s) => s.includes('medit'))).toEqual([]);
  });

  it('model.ts imports nothing from Editing', () => {
    expect(importsOf(read('modmanager/model.ts')).filter((s) => s.includes('medit'))).toEqual([]);
  });

  it('the row provider contains no record vocabulary', () => {
    // Editing's "Immutable plugin" is a distinct concept from this row's own "cannot be toggled or
    // moved" lock (ADR-0035). Bare `readonly` is a TypeScript keyword, not the domain term.
    const offending = [...read('modmanager/PluginListProvider.ts').matchAll(/\b(records?|formkeys?|recordtypes?|editorids?|immutable|read-only)\b/gi)];
    expect(offending.map((m) => m[0])).toEqual([]);
  });

  it('the child provider contains no mod vocabulary', () => {
    // Word-bounded so `model`, `modbench` and `modified` don't read as the domain term.
    const offending = [...read('medit/PluginTreeProvider.ts').matchAll(/\b(mods?|modlists?|loadouts?)\b/gi)];
    expect(offending.map((m) => m[0])).toEqual([]);
  });

  // editorCommands.ts gets the import-only tier rather than the "no vocabulary in its own text"
  // bar: it carries user-facing strings that legitimately name the other context's term for the
  // user, who thinks in MO2's vocabulary.
  it('editorCommands.ts imports nothing from Mod Management', () => {
    expect(importsOf(read('medit/editorCommands.ts')).filter((s) => s.includes('modmanager'))).toEqual([]);
  });

  // modManagementCommands.ts has no such user-facing exception, so it gets the stricter bar —
  // the stronger guard where it is free.
  it('modManagementCommands.ts imports nothing from Editing', () => {
    expect(importsOf(read('modmanager/modManagementCommands.ts')).filter((s) => s.includes('medit'))).toEqual([]);
  });

  it('modManagementCommands.ts contains no record vocabulary', () => {
    const offending = [...read('modmanager/modManagementCommands.ts').matchAll(/\b(records?|formkeys?|recordtypes?|editorids?)\b/gi)];
    expect(offending.map((m) => m[0])).toEqual([]);
  });
});
