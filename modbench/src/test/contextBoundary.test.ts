import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ADR-0035. The merged Plugins tree is one view fed by two bounded contexts, and the whole
// reason ADR-0027 could be amended rather than overridden is that the merge is structural: Mod
// Management owns the rows, Editing owns the children, and neither imports the other's vocabulary.
// That is an invariant about source text, so it is checked as one — a reviewer reading a diff that
// touches one provider has no reason to notice a term arriving from the other context.
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

  // The name filter serves views from both contexts (Mods, the merged Plugins tree,
  // Downloads), so like the composite it belongs to neither folder and lives at the composition
  // root. What makes that placement honest is the same property, so it is checked the same way:
  // structural deps, and nothing imported but `vscode`. Its own docstring cites this test — a
  // comment naming a guard that isn't guarding is worse than no comment, because it is trusted.
  it('the name filter imports from neither context', () => {
    const imports = importsOf(read('nameFilter.ts'));
    expect(imports.filter((s) => s.includes('medit') || s.includes('modmanager'))).toEqual([]);
    expect(imports).toEqual(['vscode']);
  });

  // ADR-0044: the load-order sync is the one path by which Mod Management's snapshot reaches
  // Editing, so it sits at the composition root for the same reason the two above do — and is
  // held to the same rule. The temptation here is specific and worth naming: `LoadOrderPlugin` is
  // *declared* in `modmanager/loadOrderSnapshot.ts`, and importing that type rather than keeping
  // the snapshot opaque would be a one-word change that quietly makes this module part of Mod
  // Management. It imports nothing at all — not even `vscode`.
  it('the load-order sync imports from neither context', () => {
    const imports = importsOf(read('loadOrderReconcile.ts'));
    expect(imports.filter((s) => s.includes('medit') || s.includes('modmanager'))).toEqual([]);
    expect(imports).toEqual([]);
  });

  // #628/#650: the teardown/refresh writers left extension.ts for a unit seam, and their
  // docstring claims the same structural-deps property the composite and name filter hold —
  // so it is guarded the same way: nothing imported but `vscode` (type-only, for
  // TreeView.message's MarkdownString half).
  it('the loadout teardown module imports from neither context', () => {
    const imports = importsOf(read('loadoutTeardown.ts'));
    expect(imports.filter((s) => s.includes('medit') || s.includes('modmanager'))).toEqual([]);
    expect(imports).toEqual(['vscode']);
  });

  // The sync joins the two contexts, so it may speak of a snapshot and a receiver, but never of
  // what a snapshot is made of on Mod Management's side, and never of what a plugin contains on
  // Editing's. "Send the mod list" is the sentence this file's code must not be able to write.
  // Prose is exempt for the same reason the composite is exempt from this scan entirely: a
  // joining module has to be able to say in words what it joins.
  it('the load-order sync\'s code carries neither context\'s vocabulary', () => {
    const code = read('loadOrderReconcile.ts')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect([...code.matchAll(/\b(mods?|modlists?|loadouts?)\b/gi)].map((m) => m[0])).toEqual([]);
    expect([...code.matchAll(/\b(records?|formkeys?|editorids?)\b/gi)].map((m) => m[0])).toEqual([]);
  });

  // #653: `wirePluginListInvalidation` composes the load-order watcher signals onto a second
  // consumer (`pluginListProvider.invalidate()`, alongside `sync.request()`) and is deliberately
  // typed against `{ invalidate: () => void }` rather than the real `PluginListProvider`, so it
  // never has to import Mod Management's vocabulary to do its job — the same reasoning
  // loadOrderReconcile.ts documents above, and the same "zero imports" bar, guarded here so a
  // later edit reaching for the concrete type doesn't erode it unnoticed. Unlike
  // loadOrderReconcile.ts it is not held to the vocabulary scan below: it is not a joiner of both
  // contexts, only a Mod-Management-internal wiring helper that happens to sit at the composition
  // root, and its own field names (`onModsChange`, `onModlistChange`) are necessarily
  // Mod-Management-flavored.
  it('the plugin-list invalidation wiring imports from neither context', () => {
    const imports = importsOf(read('wirePluginListInvalidation.ts'));
    expect(imports.filter((s) => s.includes('medit') || s.includes('modmanager'))).toEqual([]);
    expect(imports).toEqual([]);
  });

  // Three modmanager files the New Plugin gesture touches, none of them the merged tree's
  // own row/child/composite/filter/sync set above but all of them the same shape — plain
  // modmanager/ modules reachable from the composition root, exactly the shape that once let a
  // medit import slip in unnoticed until a reviewer's manual read caught it. Held to the
  // same "imports nothing from Editing" bar PluginListProvider's own check uses, not the stricter
  // "nothing but vscode" bar the composition-root joiners (composite/nameFilter/loadOrderSync) get —
  // these have real modmanager-internal dependencies, just never a medit/ one.
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
    // "immutable"/"read-only" pinned alongside the original record vocabulary — Editing's
    // "Immutable plugin" (read-only-for-editing) is a distinct concept from this row's own
    // "can't be toggled or moved" facts (the lock, ADR-0035) and must stay decided and named
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

  // #628: extension.ts's own decomposition — editorCommands.ts and modManagementCommands.ts
  // are genuinely single-context now (unlike extension.ts itself, still exempt as the
  // composition root that joins them). editorCommands.ts is held to the same import-only tier
  // pluginDestination.ts/Mo2ModlistSource.ts/model.ts get above, not PluginListProvider.ts's
  // stricter "no vocabulary in its own text" bar: it carries user-facing strings that
  // legitimately name the other context's term for the user's own benefit (e.g.
  // makeResolveOriginOrReport's toast, "could not resolve which mod ... belongs to" — a user
  // thinks in MO2's vocabulary even from an Editing-triggered command).
  it('editorCommands.ts imports nothing from Mod Management', () => {
    expect(importsOf(read('medit/editorCommands.ts')).filter((s) => s.includes('modmanager'))).toEqual([]);
  });

  // modManagementCommands.ts has no such user-facing exception (verified: zero occurrences of
  // Editing's own vocabulary anywhere in its text, not just its imports), so it gets
  // PluginListProvider.ts's own stricter bar instead of editorCommands.ts's weaker one — the
  // stronger guard where it's free, not the same tier as a matter of course.
  it('modManagementCommands.ts imports nothing from Editing', () => {
    expect(importsOf(read('modmanager/modManagementCommands.ts')).filter((s) => s.includes('medit'))).toEqual([]);
  });

  it('modManagementCommands.ts contains no record vocabulary', () => {
    const offending = [...read('modmanager/modManagementCommands.ts').matchAll(/\b(records?|formkeys?|recordtypes?|editorids?)\b/gi)];
    expect(offending.map((m) => m[0])).toEqual([]);
  });
});
