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
2. **A plugin is tracked when its plugin source is in a git repository in its mod's folder, and
   Track is a manual gesture.** No registry, no hidden gitdirs, no automatic repo creation. Track takes a plugin, a selection of plugins, or a mod, which tracks every plugin it holds. The
   first plugin tracked in a mod creates the mod's repository. Each plugin is serialized, verified
   by the round-trip gate over the tree it wrote, and committed to `main` as its own baseline
   commit; the edit branch is checked out once, after the last. A repo destroyed outside Modbench reads as untracked the next time
   anyone looks.
3. **The source is complete, and a tracked plugin loads from it.** Ingest deserializes the
   working tree as Effective and `HEAD` as Head and never consults the binary for content; an
   untracked plugin keeps the binary ingest and yields the same document shape, so the read model
   never sees a dialect.
4. **Every edit writes working-tree text; Save & Compile writes the binary.** Compile behaves like
   a compiler: it derives what the format forces it to derive, the masters list
   ([ADR-0008](0008-masters-are-derived-from-content.md)) and the header's counters, refuses
   only what it structurally cannot emit, and reports the rest as
   Problems-panel diagnostics. The binary it writes is the plugin's meaning, not its old bytes
   ([ADR-0006](0006-the-plugin-is-the-source-of-truth.md)). Commit is
   git's own gesture, ungated; history may hold states that do not build.
5. **The native git UI is the review surface.** One Source Control group per tracked mod, native
   diffs, native commit. Git on PATH is a product requirement.
6. **Vendored versus Authored is repo topology, not a mode.** A vendored mod keeps pristine
   upstream state on `main` and is edited on the edit branch, so `git diff main <branch>` is
   everything the user changed and compiling `main` restores the pristine plugin. An authored mod
   merges into `main` at will. A baseline commit holds one plugin, so a Track or an update that covers several plugins writes
   one commit per plugin. Its message follows git's convention. The plugin's version is two facts:
   the upstream version the mod manager records, which is informational, and the hash of the
   plugin's binary, which identifies it. The subject names the plugin and the upstream version, and
   the trailers carry both facts, read by humans and agents. A trailer may pre-select a dialog's
   default and never acts on its own.
7. **Never track a file that changes for non-content reasons.** `meta.ini` is a source of
   trailers, never tracked content: one MO2 update check rewrites it across every mod. Track
   generates the `.gitignore`, then the user owns it.

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
