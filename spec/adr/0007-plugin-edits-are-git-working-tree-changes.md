# Plugin edits are git working-tree changes

Plugin edits are git working-tree changes. A source mod's source ([ADR-0006](0006-a-compiled-plugins-truth-is-its-plugin-source.md)) lives in a repository of its own, in a source folder beside `mods/`: the plugin source, the mod's own assets, and its build file. The mod folder is the build's output, its manifest and the mod manager's files, and nothing else.

## Consequences

- The instance repository tracks files in `mods/` in place, which a nested repository would forbid.
- Editing requires a source; viewing never does. A plugin with no source is read-only. The friction is deliberate: someone else's plugin is edited as a vendored mod, with the author's releases on `main` and the user's edits on a branch.

## Alternatives rejected

- A staged pending-change model: per-field staged edits in a table, overlaid onto reads, grouped into closures that gated commit, shown in a bespoke tree. A home-grown working tree, diff and commit.
- Git kept invisible: hidden gitdirs, automatic vendoring, automatic rebase, commit as save. Each piece existed to make git automatic; manual, eager tracking deletes them all.
- A direct binary write path for mods with no source. Friction on editing a plugin with no source is wanted, and a second write path forever is the shoehorn returning.
- A repo nested inside `plugin-source/`. Splinters a multi-plugin mod into several repos.
- Commit to the branch on compile, or compile refusing a dirty tree. Commit as save again.
- Change-group gating at commit. Git's own model is that history may hold non-building states; the only door where plugin validity is at stake is compile.
