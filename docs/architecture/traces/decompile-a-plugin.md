# decompile-a-plugin: the contract

The diagram is [decompile-a-plugin.d2](decompile-a-plugin.d2). It shows how the command flows
between boxes. This file says what the user gets: when it runs, what it refuses, what it leaves
behind. The catalog rows are `track mod` and `decompile plugin` in [commands.md](../commands.md).

`decompile plugin` reads a plugin's bytes back into plugin source in the mod's git repository. It is
the inverse of `compile plugin`. It has one Option, the destination, and two callers:

- The gesture `track mod` asks for a **new repository**.
- The system trigger, a tracked mod changing on disk, asks for **main** or the **working tree**.
  The detection and the dialog are drawn in
  [a-tracked-mod-changes-on-disk](a-tracked-mod-changes-on-disk.d2).

## track mod: destination a new repository

**Available when.** The mod is untracked (no `.git` in its folder) and git is on the PATH. An
untracked plugin is read-only in the Editor, and the refusal names Track. For a plugin with no mod
folder (a vanilla, DLC or Creation Club master), the refusal says to author a patch plugin
instead.

**Options.** The preset.
- `Edits` is the default. It tracks only `source/**`.
- `Everything` also tracks the mod's assets. An upgrade then overwrites tracked assets as
  working-tree changes.

The binaries are ignored in both. The `.gitignore` is generated once, then it belongs to the user.

**Result.**
- `main` holds one commit of the pristine state. It carries the optional trailers
  `Upstream-Version`, `Binary-SHA256` and `Meta-SHA256`, read from `meta.ini` as opaque bytes.
- The edit branch is checked out, and a parked ref is initialised.
- The mod appears in Source Control.
- The repository sets `core.autocrlf=false`, because byte equality depends on it.

Progress is reported per plugin.

**Refused when.**
- The round-trip gate finds a dropped subrecord. The refusal names the record type, the FormID and
  the dropped signatures. These are not refusals: more occurrences of a canonical marker, and the
  drop of a header's master entries, which is sanctioned master pruning
  ([ADR-0008](../../adr/0008-masters-are-derived-from-content.md)), including the renumbering of
  master indices after a partial prune.
- A localized plugin's strings file is missing. Strings resolve from the mod's `Strings/`, then
  from Data. The refusal names the file.
- Git is not on the PATH.

**On failure.** The folder is left as if the gesture was never attempted. The `.git` folder, the
`.gitignore` and any partial `source/` are removed.

**Confirms.** Nothing. The gesture is manual and deliberate ([ADR-0007](../../adr/0007-plugin-edits-are-git-working-tree-changes.md)).

## decompile plugin: destination main

**Runs when.** The watcher settles a tracked mod and its `meta.ini` version moved away from the
baseline's trailer. That means a new release. Whether it asks first is open. Today one dialog per
mod asks, with this answer as the default.

**Result.**
- The plugin documents and every changed tracked file, deletions included, are committed to `main`
  as the new baseline.
- The rebase of the edit branch is attempted at once. The baseline commit stands whatever the
  rebase does.
- A clean rebase is silent.
- A rebase refused over uncommitted source changes names the paths and points to `rebase edit
  branch`.
- A conflict opens the native merge editor.
- A tracked file outside `source/` rides the rebase (an autostash).

**Refused when.** The binary cannot be parsed, or git is missing. An error notification names the
plugin and the reason, nothing is committed, and the question stays open, so the other destination
is still available.

## decompile plugin: destination the working tree

**Runs when.** The watcher settles a tracked mod, the plugin's bytes differ from the baseline, and
`meta.ini` did not move. That means an edit made in another tool.

**Result.** The changed records land as uncommitted changes on the current branch. Applied files are
staged as they are, deletions included, so the same bytes do not raise the question again. A
container record that was never in the tree is skipped and logged, not landed.

**Refused when.**
- A record the change touches already has uncommitted source changes. The whole command is refused
  and names the records.
- A tracked file from an earlier unresolved answer is already staged. The refusal names the path.

## Not this command

- **A destroyed repository.** If the mod's `.git` is gone (an MO2 Replace install), that is not an
  external change. The mod reads as untracked, and `track mod` applies again.
- **Deferring.** The dialog's Esc, and what a deferred change does to edits and compile, belong to the
  detection story in a-tracked-mod-changes-on-disk.
- **The dialog's wording.** Its buttons, order and default rule are in the detection story too.

## Refusal posture

Every refusal here follows git's own: refuse, name what is in the way, and let the user fix it. No
destination repairs a collision on its own.
