# Phase 16.2.1 — Writer Generalization: copy + delete placed paths + typed cache

**Status: Complete** · Parent: [phase-16.2](phase-16.2.md) · Depends on: spike · **Model: Opus**

*Goal: extend the proven create mechanism into the copy-as-override and delete writer paths, and wire
the production save path to hand `PluginWriter` a typed link cache.* See [phase-16.2.md](phase-16.2.md)
for shared decisions.

Two wrinkles drive this sub-phase: (a) copy-as-override of a placed ref can't use `ApplyFieldChanges`
— the ref isn't in the target mod yet, so `mod.EnumerateMajorRecords()` finds nothing; (b) delete of
a placed ref can't use `schema.Remove` — placed refs aren't in a top-level GRUP.

---

## Backend

- [x] **Typed cache wiring.** `SessionManager.SavePlugin`/`PreparePluginSave` (the production callers
  of `PluginWriter`) now build a typed cache via `TypedLinkCacheFactory.Create(mods, release)` —
  reflection over the game's mod types resolves `ToImmutableLinkCache<TMod,TModGetter>` (same all-games
  approach as `SchemaReflector`), stored as the non-generic `ILinkCache` and passed into the writer.
- [x] **Copy-as-override placed branch** (`PluginWriter.TryMaterializePlacedCopy`). When a group of
  field_edit changes carries `ParentCell` but the ref is absent from `mod`, the writer resolves the
  ref's winning context and `GetOrAddAsOverride`s it — Mutagen rebuilds the cell→ref parentage,
  pulling the parent cell in as an override and deep-copying just that ref. Staged field edits then
  apply onto the materialised record. (Cleaner than a manual cell-override + DeepCopy: resolving the
  *ref* context, not the cell, lets Mutagen do the parentage + copy.)
- [x] **Delete placed branch** (`PluginWriter.TryDeletePlaced`). When the delete change carries
  `ParentCell`, the writer pulls the parent cell in as an override (`ResolveWinnerAsOverride`) and
  removes the placed ref from its Persistent/Temporary list by FormKey. Scoped to refs the plugin
  itself contains (matching `DeleteRecords`' per-plugin targets); a master-only cell override comes in
  empty, so "deleting" a master ref via override is a no-op by construction. Reference-nullification of
  other records is unchanged.

Helper rename: `GetOrAddCellOverride` → `ResolveWinnerAsOverride` (now resolves either a cell or a
placed ref — same reflection, generalised).

## Tests (`dotnet test`, real FO4 fixtures)

- [x] `SessionManagerTests.SavePlugin_CreatePlacedInMasterCell_LandsRefUnderOverrideCell` — placed
  `$create` through the real session save path lands the ref under the override cell (proves the
  typed-cache wiring, not just the hand-built-cache spike).
- [x] `PluginWriterPlacedTests.SaveAsync_CopyPlacedAsOverride_RefAppearsInOverrideCellWithBaseDeepCopied`
  — copy of a master placed ref produces an override cell with the deep-copied ref (Base preserved);
  round-trips through save.
- [x] `PluginWriterPlacedTests.SaveAsync_DeletePlaced_RemovesRefFromCellAndKeepsSiblings` — targeted
  ref removed from its cell, sibling retained; round-trips through save.
- [x] Non-placed create/copy/delete paths unaffected (existing suites green).

## Proof

`dotnet test`: **725 passing** (3 new + spike green; the only non-passes are `RealGameLoadTests`,
which load the full real vanilla FO4 install over HTTP and intermittently exceed the client read
timeout under concurrent CPU load — they pass in isolation at timing identical to the clean tree, and
this sub-phase touches only the save path, never session load). `dotnet build` clean (0 warnings);
`dotnet format` clean. Commit hash: *pending (await batch commit per close-out workflow)*.
