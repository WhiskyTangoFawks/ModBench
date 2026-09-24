# decompile-plugin: contract (draft)

Diagram: [decompile-plugin.d2](decompile-plugin.d2). It draws the detection and the question as
the system trigger, because they are how the command is fired, and the command is one. Catalog rows: `track`
under Mod and under Plugin, `rebase edit branch` under Mod, and the system command `decompile plugin`, in
[commands.md](../commands.md). Governed by
[ADR-0003](../../adr/0003-modbench-never-assumes-exclusive-ownership-of-a-file.md),
[ADR-0006](../../adr/0006-the-plugin-is-the-source-of-truth.md),
[ADR-0007](../../adr/0007-plugin-edits-are-git-working-tree-changes.md) and
[ADR-0008](../../adr/0008-masters-are-derived-from-content.md).

`decompile plugin` reads a plugin's bytes into plugin source in the mod's git repository. It is the
inverse of `compile`. Its Option is the destination: a new repository, `main`, or the working tree.
Whether it ends as one registered command or two is settled in the ticket "One decompile command: the
destination as an option".

Each story cites its source. **Ruling** means the maintainer decided it and nothing else states it.

## Shared

As a user, I want:

1. Every record of the plugin read into source, and the round trip checked over the tree that was
   written. A record with no model-identical counterpart refused, naming it. *ADR-0006, invariant 2;
   ADR-0019*
2. Master entries the content does not need dropped, with no refusal. *ADR-0008*
3. A binary that cannot be parsed, or git missing from the PATH, refused with the plugin and the
   reason. *ADR-0007, invariant 5; Refuse, do not repair*
4. A failure to write nothing of its own, and to tell me why. The commits that landed before it
   stand; this contract's exception to the principle. *A failed gesture writes nothing; ADR-0019*
5. My own concurrent change preserved and named, never reverted. *ADR-0003, invariant 4*
6. Review and commit to be git's own, in the Source Control panel. *ADR-0007, invariant 5*

## track: the destination is the mod's repository

1. Track offered on a plugin that is untracked, and on a mod that holds one. *catalog Where; ADR-0007,
   invariant 2*
2. Track on a plugin, or on a selection of plugins, to track each one; Track on a mod to track every
   untracked plugin it holds. The first creates the mod's repository if it has none. Each plugin
   lands or is refused on its own. *ADR-0007, invariant 2; A selection is one gesture*
3. Tracking a plugin into a mod that already has a repository to do only what track does. Keeping
   `main` and the edit branch in order when several plugins share a repository is mine. *ruling*
4. To choose a preset: `Edits` or `Everything`. *catalog Options*
5. Track to be my own deliberate gesture, with no confirmation. *ADR-0007, invariant 2*
6. Each plugin's pristine state committed to `main` as its own commit, and the edit branch checked
   out once, after the last. *ADR-0007, invariants 2 and 6*
7. Each baseline commit's message in git's convention: a subject of the verb, the plugin and its
   upstream version (`Track Foo.esp 1.2.3`), a blank line, then the trailers `Plugin`,
   `Upstream-Version`, `Meta-SHA256` and `Binary-SHA256`. The upstream version is informational;
   the binary's hash identifies the plugin. A version the mod manager does not record is left out
   of the subject and the trailers. *ADR-0007, invariant 6*
8. `meta.ini` never tracked, because one MO2 update check rewrites it across every mod. *ADR-0007,
   invariant 7*
9. The `.gitignore` generated once, and then mine. *ADR-0007, invariant 7*
10. The mod to appear in Source Control as one group. *ADR-0007, invariant 5*
11. The mod's own files, the `.gitignore` and, under `Everything`, its assets, committed once, in a
    commit of their own before the first plugin's (`Track <mod>`). *ruling*
12. A plugin refused to leave nothing of its own behind, and the plugins committed before it to
    stay committed. No rollback beyond git's: each commit is its own unit. *ruling: git handles it*

## The external change: how the destination is chosen

The trigger is the watcher settling a tracked mod that changed.

1. A mod to count as changed when a plugin's bytes differ from what Modbench last wrote, or a file git
   tracks outside `source/` differs from git's view of the edit branch. *ADR-0003, invariant 3*
2. To be asked once for each mod, never once for each plugin, and one answer to cover every plugin and
   every changed tracked file. *ADR-0003, invariant 3*
3. Two answers: a new baseline on `main`, or my own edit as working-tree changes. *ADR-0003,
   invariant 3; catalog Options*
4. The default to follow `meta.ini`. A moved version pre-selects the new baseline. The file never
   triggers the question. *ADR-0003, invariant 3; ADR-0007, invariant 6*
5. Esc to defer, and to change nothing. *Esc changes nothing*
6. While the question is open, every plugin of the mod to refuse writes, including compile, because a
   compile would overwrite the evidence. *ADR-0003, invariant 3*
7. Bytes I restore by hand to end the question with no answer. *ADR-0003, invariant 3*
8. A mod whose `.git` has gone to read as untracked, with every plugin in it, with no question, so
   Track applies again.
   *ADR-0007, invariant 2*
9. A refusal to leave the question open, so the other answer is still available. *Refuse, do not
   repair*

## decompile plugin: the destination is `main`

1. Each changed plugin's documents committed to `main` as its own baseline commit
   (`Update Foo.esp to 1.2.4`), then every other changed tracked file in one commit after them.
   *ADR-0003, invariant 3; ADR-0007, invariant 6*
2. A commit that fails to stop there. The commits before it stand, the edit branch is rebased onto
   what landed, and the question stays open for what is left, so answering again finishes it. No
   rollback. *ruling: git handles it; ADR-0003, invariant 3: the classifier is the authority*
3. My edit branch rebased onto `main` at once, and the baseline to stand whatever the rebase does.
   *diagram*
4. A clean rebase to say nothing. *diagram*
5. A rebase refused over my uncommitted source changes to name the paths and point at `rebase edit
   branch`. *diagram*
6. A conflict to open the native merge editor. *diagram; ADR-0007, invariant 5*

## decompile plugin: the destination is the working tree

1. The changed records to land as uncommitted changes on my current branch. *ADR-0003, invariant 3*
2. A record I have already changed to refuse the whole command, naming the records. *ADR-0003,
   invariant 4; Refuse, do not repair*

## rebase edit branch

1. To replay the edit branch onto `main` when I choose. *catalog Meaning*
2. Offered only for a mod that is tracked. *catalog Where*

## Test seam

- **The driving box** (Plugins, Editor): the dialog, its buttons, its default, and Esc.
- **The commands box:** given a destination, the plugin bytes and the repository, the documents and
  commits written, or the refusal.
- **The watcher:** given a settled mod and git's view, the pending change it announces, with its
  default.

## Open Questions

1. **Does the trigger ask at all?** The diagram says this is open, and one dialog asks today. These
   stories assume it asks.
2. **The dialog wording.** The old spec has the message name the mod, list changed plugins by name and
   changed tracked files by count and name, and say either that the `meta.ini` version moved from one
   value to another, or that no version change was seen. Accept? Do you want the exact text fixed?
3. **The buttons.** The old spec has `Commit to main as new baseline`, `Apply to working tree on
   <branch>` and Esc, and the button order is the default, with no separate flag. Accept?
4. **The queue.** The old spec asks one mod at a time, never one dialog for several. Accept?
5. **Reads while deferred.** The old spec keeps serving the last known state and points the refusal at
   the open question. ADR-0003 says only that writes are refused. Add?
6. **Re-asking.** The old spec asks again at the next detection or load. Accept?
7. **What the presets track.** The old spec says `Edits` tracks only `source/**`, `Everything` also
   tracks the mod's assets, and binaries are ignored in both. The catalog names only the presets.
   Accept the meaning?
8. **Progress.** The old spec reports progress per plugin, in the view header. Accept?
9. **`core.autocrlf`.** The old spec sets it to false in the repository, because byte equality depends
   on it. Accept?
10. **Localized plugins.** A missing strings file refuses, naming it, and strings resolve from the mod's
    `Strings/` then from the game folder. Accept?
11. **What is not a refusal.** The old spec says more occurrences of a canonical marker are not a
    refusal. Shared story 2 covers the master case. Does the marker case need a story?
12. **A plugin with no mod folder.** For a vanilla plugin the old spec points at authoring a patch
    plugin instead of naming Track. Accept?
13. **Staged files.** The old spec stages applied files as they are, deletions included, so the same
    bytes do not raise the question again, and refuses when a tracked file from an earlier unresolved
    answer is already staged. Accept?
14. **Tracked files outside `source/`.** The old spec says they ride the rebase in an autostash.
    Accept?
15. **An untracked or authored mod.** The decompile ticket asks what a moved `meta.ini` version means
    for a mod with no upstream. Open there.
16. **The committed `decompile-plugin.md`.** It holds the same facts in the label format. Delete it
    when you accept this draft?
