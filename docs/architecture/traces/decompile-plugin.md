# decompile-plugin: contract

Diagram: [decompile-plugin.d2](decompile-plugin.d2). Catalog row: `track` under Mod, in
[commands.md](../commands.md). What the user picks is in [plugins.md](../surfaces/plugins.md):
Track. Governed by
[ADR-0003](../../adr/0003-modbench-never-assumes-exclusive-ownership-of-a-file.md),
[ADR-0006](../../adr/0006-decompilation-is-provably-faithful.md),
[ADR-0007](../../adr/0007-plugin-edits-are-git-working-tree-changes.md),
[ADR-0008](../../adr/0008-masters-are-derived-from-content.md) and
[ADR-0015](../../adr/0015-edits-reach-the-read-model-through-the-watcher.md).

`decompile plugin` reads a plugin's bytes into plugin source in its mod's repository. It is the
inverse of `compile`. The gesture `track` fires it.

## The command

1. Plugins sends `decompile plugin` to Commands, through the mEdit client and the HTTP endpoints:
   the plugins, each as origin and file name, and the preset. Each plugin carries its mod's
   upstream version, as the mod manager records it.
2. For each plugin in turn, the Plugin adapter reads its bytes, and Commands reads every record
   into documents. A localized plugin's strings come from the mod's `Strings/` folder, then from
   the game's.
3. Commands drops the masters that the content does not need (ADR-0008). It then checks the round
   trip: every record has a model-identical counterpart, and no subrecord is lost (ADR-0006,
   invariant 2). Nothing of the plugin is written before its check passes.
4. Commands publishes track progress, per plugin and phase, through Ports.
5. The Source adapter puts the plugin's documents in the mod's repository. In a mod with no
   repository, once the first plugin passes its check, it creates one with the preset's
   `.gitignore`, keeping line endings as written, and commits the mod's own files in a commit of
   their own (`Track <mod>`): the `.gitignore` and, under `Everything`, the assets. It then commits
   the plugin's documents to `main` as the plugin's baseline (`Track Foo.esp 1.2.3`), with no
   checkout.
6. Commands records each plugin's bytes as what Modbench last wrote.
7. After the last plugin, in a repository this run created, the Source adapter creates the edit
   branch at `main` and checks it out. Otherwise the edit branch does not move: the user rebases it
   onto the new baselines with git, in VS Code's Source Control (ADR-0007, invariant 5).
8. Commands answers applied or the refusal, per plugin.

A baseline commit's message follows git's convention: the subject, a blank line, then the trailers
`Plugin`, `Upstream-Version` and `Binary-SHA256` (ADR-0007, invariant 6). A version the mod
manager does not record is left out of the subject and the trailers.

| Preset | The repository tracks |
|---|---|
| Edits | `source/` and `.gitignore` |
| Everything | every file except the plugin binaries |

Both presets ignore `meta.ini` (ADR-0007, invariant 7). Track writes the `.gitignore` once, and
then the user owns it.

## Hand-off

This flow waits for no hand-off.

- The Mod watcher sees the source change, and the Indexer refreshes the keys. Once a plugin is
  tracked, the Indexer reads its documents, not its bytes
  ([index-load-order](index-load-order.d2)).

## Refusals

Commands names the cause.

| Refusal | Why |
|---|---|
| Git is not on the PATH, once for the whole selection | No plugin can escape it. |
| The plugin is in no mod: the game folder or Overwrite | A repository lives in a mod's folder. The refusal points at a patch plugin. |
| The plugin is already tracked | |
| The bytes cannot be read or parsed | Diagnosed, never repaired (ADR-0006, invariant 7). |
| A record fails the round trip, naming the record and what was lost | ADR-0006, invariant 2. |
| A localized plugin's strings file is missing, naming the file and where Modbench looked | |

## Failure

No rollback beyond git's: each commit is its own unit (ruling: git handles it).

- A refused plugin leaves nothing of its own. The plugins committed before it stay committed, and
  the rest go on.
- When every plugin is refused, nothing is written: the repository is created only once the first
  plugin passes its check.

Exceptions to commands.md's rules:

- **A failed gesture writes nothing.** The commits that landed before a failure stand.

## Test seam

- **Commands:** given the plugins, a preset and the repository, the documents, commits, messages
  and refs written, or the refusal and nothing of that plugin written.
