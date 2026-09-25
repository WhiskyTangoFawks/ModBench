# decompile-plugin: contract

Diagram: [decompile-plugin.d2](decompile-plugin.d2). Catalog rows: `track` under Mod and under
Plugin, `rebase edit branch` under Mod, and the system command `decompile plugin`, in
[commands.md](../commands.md). What the user picks and answers is in
[plugins.md](../surfaces/plugins.md): Track, External change and Rebase edit branch. Governed by
[ADR-0003](../../adr/0003-modbench-never-assumes-exclusive-ownership-of-a-file.md),
[ADR-0006](../../adr/0006-decompilation-is-provably-faithful.md),
[ADR-0007](../../adr/0007-plugin-edits-are-git-working-tree-changes.md),
[ADR-0008](../../adr/0008-masters-are-derived-from-content.md) and
[ADR-0015](../../adr/0015-edits-reach-the-read-model-through-the-watcher.md).

`decompile plugin` reads a plugin's bytes into plugin source in its mod's repository. It is the
inverse of `compile`. Its Option is the destination: the mod's repository, `main`, or the working
tree. The gesture `track` fires it to the repository. The system trigger fires it to `main` or to
the working tree, as the user answers.

## The trigger

1. The Mod watcher waits until a tracked mod's folder is quiet, then classifies the mod once,
   against git and never against the paths that changed. The load-time check classifies every
   tracked mod the same way (ADR-0003, invariant 3).
2. The mod has changed when a tracked plugin's bytes differ from what Modbench last wrote, or when
   a file git tracks outside `source/` differs from the edit branch. `meta.ini` alone never
   changes the mod. The default is always `main`.
3. An untracked plugin in the mod is not part of the question: it has no source to lose. Commands
   publishes it through Ports as an untracked plugin in a tracked mod, and Plugins warns. It opens no
   question and refuses nothing. Tracking it is the user's gesture.
4. Commands records the open question in the mod's repository and publishes it through Ports: the
   mod, the changed plugins and the changed tracked files. The HTTP endpoints stream it to the
   mEdit client, and Plugins asks first.
5. A later classification that finds nothing ends the question with no answer, so bytes restored
   by hand end it. An unanswered question is published again at each settle and load-time check
   that still finds the change.

While a question is open, Commands refuses every write to every plugin the mod holds, compile
included, and the refusal names the question: a compile would overwrite the evidence. Reads go on
serving the last state.

## The command

1. Plugins sends `decompile plugin` to Commands, through the mEdit client and the HTTP endpoints:
   the plugins, each as origin and file name, and the destination. `track` also sends the preset.
2. For each plugin in turn, the Plugin adapter reads its bytes, and Commands reads every record
   into documents. A localized plugin's strings come from the mod's `Strings/` folder, then from
   the game's.
3. Commands drops the masters that the content does not need (ADR-0008). It then checks the round
   trip: every record has a model-identical counterpart, and no subrecord is lost (ADR-0006,
   invariant 2). Nothing of the plugin is written before its check passes.
4. Commands publishes track progress, per plugin and phase, through Ports.
5. The Source adapter puts the plugin's documents at the destination:
   - **The repository.** In a mod with no repository, once the first plugin passes its check, it
     creates one with the preset's `.gitignore`, keeping line endings as written, and commits the mod's own files in a commit of
     their own (`Track <mod>`): the `.gitignore` and, under `Everything`, the assets. It then
     commits the plugin's documents to `main` as the plugin's baseline (`Track Foo.esp 1.2.3`),
     with no checkout.
   - **`main`.** It commits the plugin's documents to `main` as the plugin's new baseline
     (`Update Foo.esp to 1.2.4`), with no checkout. After the last plugin, every other changed
     tracked file goes to `main` in one commit.
   - **The working tree.** It writes each record that changed as an uncommitted change on the
     current branch. After the last plugin, it stages every changed tracked file as it is,
     deletions included, so the same bytes do not open the question again.
6. Commands records each plugin's bytes as what Modbench last wrote.
7. After the last plugin, in a repository this run created, the Source adapter creates the edit
   branch at `main` and checks it out. Otherwise the edit branch does not move: the user replays it
   onto the new baselines with `rebase edit branch`.
8. For the system trigger, Commands ends the question.
9. Commands answers applied or the refusal, per plugin.

A baseline commit's message follows git's convention: the subject, a blank line, then the trailers
`Plugin`, `Upstream-Version` and `Binary-SHA256` (ADR-0007, invariant 6). A version the mod
manager does not record is left out of the subject and the trailers.

| Preset | The repository tracks |
|---|---|
| Edits | `source/` and `.gitignore` |
| Everything | every file except the plugin binaries |

Both presets ignore `meta.ini` (ADR-0007, invariant 7). Track writes the `.gitignore` once, and
then the user owns it.

## rebase edit branch

The gesture replays the edit branch onto `main`, and carries changed tracked files outside
`source/` through the rebase. It is the only thing that rebases the edit branch. It ends clean,
refused, or conflicted, and a conflicted rebase is git's to finish.

## Hand-off

This flow waits for no hand-off.

- The Mod watcher sees the source change, and the Indexer refreshes the keys. Once a plugin is
  tracked, the Indexer reads its documents, not its bytes
  ([index-load-order](index-load-order.d2)).
- A conflicted rebase is git's to finish, in the native merge editor and Source Control (ADR-0007,
  invariant 5).

## Refusals

Commands names the cause. A refusal leaves the question open, so the other answer stays available.

| Refusal | Where | Why |
|---|---|---|
| Git is not on the PATH | every destination, once for the whole selection | No plugin can escape it. |
| A question is open on the mod | the repository, `rebase edit branch` | ADR-0003, invariant 3. |
| The plugin is in no mod: the game folder or Overwrite | the repository | A repository lives in a mod's folder. The refusal points at a patch plugin. |
| The plugin is already tracked | the repository | |
| The mod has uncommitted changes in `source/`, naming the paths | `rebase edit branch` | Git's own rule. |
| A rebase is already in progress | `rebase edit branch` | Git's Source Control finishes it (ADR-0007, invariant 5). |
| The bytes cannot be read or parsed | every destination | Diagnosed, never repaired (ADR-0006, invariant 7). |
| A record fails the round trip, naming the record and what was lost | every destination | ADR-0006, invariant 2. |
| A localized plugin's strings file is missing, naming the file and where Modbench looked | every destination | |
| A changed record also has an uncommitted change, naming the records | the working tree | A concurrent change is preserved (ADR-0003, invariant 4). |
| A changed tracked file is already staged from an earlier answer, naming it | the working tree | |

## Failure

No rollback beyond git's: each commit is its own unit (ruling: git handles it).

- **The repository.** A refused plugin leaves nothing of its own. The plugins committed before it
  stay committed, and the rest go on.
- **The repository, when every plugin is refused.** Nothing is written: the repository is created
  only once the first plugin passes its check.
- **`main`.** A commit that fails stops the run. The commits before it stand, and the question
  stays open for the rest, so answering again finishes it.
- **The working tree.** A failure stops the run and says so, naming what failed. The files written
  before it stay as uncommitted changes, for the user to keep or discard with git.

Exceptions to the principles:

- **A failed gesture writes nothing.** The commits that landed before a failure stand, and so do
  the working-tree files written before it.
- **A selection is one gesture, and each item lands on its own.** An answer to the question
  covers the whole mod: a working-tree refusal refuses every plugin in it, and a failed commit to
  `main` stops the rest (ADR-0003, invariant 3).
- **Confirm what destroys.** Neither answer asks again: the question is the confirmation.

## Test seam

- **The Mod watcher:** given a settled mod and git's view of it, the question it opens and its
  default, or none.
- **Commands:** given the plugins, a destination, a preset and the repository, the documents,
  commits, messages, refs and staged files written, or the refusal and nothing of that plugin
  written.
- **`rebase edit branch`:** given the repository, the rebase outcome, or the refusal.
