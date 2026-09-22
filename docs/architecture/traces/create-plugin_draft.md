# create-plugin: contract (draft)

Diagram: none yet. Catalog row: `create` under Plugin in [commands.md](../commands.md). Governed by
[ADR-0003](../../adr/0003-modbench-never-assumes-exclusive-ownership-of-a-file.md),
[ADR-0006](../../adr/0006-the-plugin-is-the-source-of-truth.md),
[ADR-0007](../../adr/0007-plugin-edits-are-git-working-tree-changes.md) and
[ADR-0017](../../adr/0017-mo2-is-the-reference-for-mod-management.md).

Each story cites its source. No diagram exists, so the seams below are provisional.

## create

As a user, I want:

1. To create a plugin in a mod. *catalog Meaning*
2. The gesture offered on the Plugins title bar. *catalog Where*
3. Prompts for what I did not give. *surface supplies the Argument, a picker supplies the Options*
4. Esc on any prompt to create nothing. *Esc changes nothing*
5. A plugin that already exists refused, naming it. *ruling: refuse, never silently destroy*
6. The new plugin not to be tracked until I track it. *ADR-0007, invariant 2*
7. A failed create to leave the mod as it was, and to tell me why. *A failed gesture writes nothing;
   ADR-0019*
8. The `plugins.txt` line to be added only after the plugin file exists and can be read. *A failed
   gesture writes nothing*
9. The new plugin to reach the views through the watcher, like any change. *A write is forgotten;
   ADR-0015*

## Test seam

- **The Plugins view:** the prompts, and Esc.
- **The commands box:** given a mod and a name, the plugin file written, or the refusal.

## Open Questions

1. **Argument.** The catalog says the Argument is a `mod`, and `create` makes a plugin inside it. The
   old spec asks for a destination instead: the `overwrite/` folder first, as the default, or an existing
   mod. Which?
2. **Untracked means read-only.** ADR-0007 makes an untracked plugin read-only in the Editor. So a plugin
   I just created cannot be edited until I Track it. Does create offer Track?
3. **Enabled or disabled.** Is the new plugin's line enabled or disabled? MO2 adds a plugin it finds on
   disk as disabled. A plugin the user creates is not found on disk.
4. **The name.** The old spec asks for a name ending `.esp`, `.esm` or `.esl`. Accept?
5. **Games.** Which plugin types and flags a game allows is per game. Where is that decided?
6. **Position.** Where does the new line go in `plugins.txt`? The diagram is not drawn.
