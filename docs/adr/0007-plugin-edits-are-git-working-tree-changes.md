# Plugin edits are git working-tree changes

Version control is foundational to working with an agent in a domain where automated validation
is next to impossible: the user needs oversight of what the agent did and an easy roll-back of
what it did wrong. Git gives both, and VS Code's Source Control panel shows them. So a tracked
mod's source ([ADR-0006](0006-the-plugin-is-the-source-of-truth.md)) lives in a git
working tree inside the mod folder, every edit is a change to that tree, and Save & Compile writes
the binary from it.

## Strategic invariants

1. **Editing requires tracking; viewing never does.** An untracked plugin is hard read-only in
   the editor, with signposting that names the Track command. That friction is deliberate: the
   blessed paths for someone else's plugin are a patch or a vendored mod, edited on its edit branch after Track. The
   read path, deep parse, conflicts and the compare grid, never requires source.
2. **Tracked is the presence of `.git` in the mod folder, and Track is a manual gesture.** No
   registry, no hidden gitdirs, no automatic repo creation. Track serializes every record of the
   mod's plugins, verifies the round-trip gate over the tree it wrote, commits the pristine state
   to `main`, and checks out an edit branch. A repo destroyed outside Modbench reads as untracked
   the next time anyone looks.
3. **The source is complete, and a tracked plugin loads from it.** Ingest deserializes the
   working tree as Effective and `HEAD` as Head and never consults the binary for content; an
   untracked plugin keeps the binary ingest and yields the same document shape, so the read model
   never sees a dialect.
4. **Every edit writes working-tree text; Save & Compile writes the binary.** Compile behaves like
   a compiler: it derives what the format forces it to derive, the masters list
   ([ADR-0008](0008-masters-are-derived-from-content.md)), the header's counters and renumber
   cascades, refuses only what it structurally cannot emit, and reports the rest as
   Problems-panel diagnostics. The binary it writes is the plugin's meaning, not its old bytes
   ([ADR-0006](0006-the-plugin-is-the-source-of-truth.md)). Commit is
   git's own gesture, ungated; history may hold states that do not build.
5. **The native git UI is the review surface.** One Source Control group per tracked mod, native
   diffs, native commit. Git on PATH is a product requirement.
6. **Vendored versus Authored is repo topology, not a mode.** A vendored mod keeps pristine
   upstream state on `main` and is edited on the edit branch, so `git diff main <branch>` is
   everything the user changed and compiling `main` restores the pristine plugin. An authored mod
   merges into `main` at will. Baseline commits carry trailers for the upstream version and the
   binary's hash, read by humans and agents; a trailer may pre-select a dialog's default and never
   acts on its own.
7. **Never track a file that changes for non-content reasons.** `meta.ini` is a source of
   trailers, never tracked content: one MO2 update check rewrites it across every mod. Track
   generates the `.gitignore`, then the user owns it.
8. **A write that spans repositories is all-or-nothing, without git.** A renumber cascade
   rewrites every source tree holding a reference. The pre-image of each file it writes is held in
   memory for the call and put back in reverse order on failure; an act whose pre-image is not one
   document's bytes is refused before the tree is touched. Nothing is written into the author's
   repository and no ref is created. A third party's concurrent write is preserved and named,
   never reverted ([ADR-0003](0003-modbench-never-assumes-exclusive-ownership-of-a-file.md)). A
   rollback that cannot complete reports every unrestored path, structured, and never stops at
   the first. Process death is out of scope: the compile round-trip gate and re-Track remain the
   recovery for a tree left mid-write by a crash. The record index is re-derived through the
   watcher, never rolled back.

## Alternatives rejected

- **A staged pending-change model**: per-field staged edits in a table, overlaid onto reads,
  grouped into closures that gated commit, shown in a bespoke tree. A home-grown working tree,
  diff and commit.
- **Git kept invisible**: hidden gitdirs, automatic vendoring, automatic rebase, commit as save.
  Each piece existed to make git automatic; manual, eager tracking deletes them all.
- **A direct binary write path for untracked mods.** Friction on untracked editing is wanted, and
  a second write path forever is the shoehorn returning.
- **A repo nested inside the source folder.** Splinters a multi-plugin mod into several repos.
- **Commit to the branch on compile**, or compile refusing a dirty tree. Commit as save again;
  the parked ref ([ADR-0003](0003-modbench-never-assumes-exclusive-ownership-of-a-file.md)) gives the same
  guarantee without touching the branch.
- **Change-group gating at commit.** Git's own model is that history may hold non-building
  states; the only door where plugin validity is at stake is compile.
- **Disclose a partial cascade and let the author revert per repository.** A referencer rewritten
  to an identity the target never took is a dangling link, strictly worse than not written; a
  half-done renumber does not converge on re-run, so the only honest repair is the restore.
- **An on-disk journal so a cascade survives process death**, as the multi-plugin compile batch
  has. New state in the author's folder with new staleness, for a failure the existing gate
  already catches; a compiled plugin is its own complete artifact, a half-rewritten reference is
  not.
