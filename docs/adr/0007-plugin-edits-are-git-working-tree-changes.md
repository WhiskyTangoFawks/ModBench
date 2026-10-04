# Plugin edits are git working-tree changes

Version control is foundational to working with an agent in a domain where automated validation is next to impossible: the user needs oversight of what the agent did and an easy roll-back of what it did wrong. Git gives both, and VS Code's Source Control panel shows them. So a tracked mod's source ([ADR-0006](0006-a-tracked-plugins-truth-is-its-source.md)) lives in a git working tree inside the mod folder, and every edit is a change to that tree.

## Consequences

- Editing requires tracking; viewing never does. An untracked plugin is read-only. The friction is deliberate: someone else's plugin is edited as a vendored mod, with upstream on `main` and the user's edits on a branch.

## Alternatives rejected

- A staged pending-change model: per-field staged edits in a table, overlaid onto reads, grouped into closures that gated commit, shown in a bespoke tree. A home-grown working tree, diff and commit.
- Git kept invisible: hidden gitdirs, automatic vendoring, automatic rebase, commit as save. Each piece existed to make git automatic; manual, eager tracking deletes them all.
- A direct binary write path for untracked mods. Friction on untracked editing is wanted, and a second write path forever is the shoehorn returning.
- A repo nested inside the source folder. Splinters a multi-plugin mod into several repos.
- Commit to the branch on compile, or compile refusing a dirty tree. Commit as save again.
- Change-group gating at commit. Git's own model is that history may hold non-building states; the only door where plugin validity is at stake is compile.
