# detect-external-change: contract

Diagram: [detect-external-change.d2](detect-external-change.d2). No catalog row names this flow. A
change on disk starts it, never a gesture or a command. What the user sees is in
[plugins.md](../surfaces/plugins.md): A row, Plugin, and Reporting. Governed by
[ADR-0003](../../adr/0003-modbench-never-assumes-exclusive-ownership-of-a-file.md) and
[ADR-0015](../../adr/0015-edits-reach-the-read-model-through-the-watcher.md).

A tracked plugin exists twice in its mod: the binary, which the game and every other tool read and
write, and its plugin source, which git versions. Git shows every change to the source and to every
other tracked file. The binary is the one copy git cannot see. This flow tells the user that a
binary changed outside Modbench, and it ends there. The user decides what to do next.

## The flow

1. The Mod watcher waits until a tracked mod's folder is quiet, then tells Commands the mod
   settled. At load, Commands checks every tracked mod the same way.
2. Commands compares each tracked plugin's bytes with what Modbench last wrote
   ([compile-plugin](compile-plugin.md), step 5; [decompile-plugin](decompile-plugin.md), step 6).
   A plugin whose bytes differ changed outside Modbench.
3. An untracked plugin in the mod has no source to compare. Commands names it beside the change.
4. Commands publishes the mod through Ports: the plugins that changed outside Modbench, and the
   untracked plugins. A check that finds neither publishes that too, so an earlier notice clears.
   The HTTP endpoints stream it to the mEdit client, and Plugins shows it.
5. Commands keeps nothing about the change. Each check starts again from the disk.

## Hand-off

This flow waits for no hand-off.

- Compile writes the binary from the source, so a compile of a plugin that changed outside
  Modbench replaces that change ([compile-plugin](compile-plugin.md)).

## Failure

- **A plugin whose file is gone or cannot be read** counts as changed, and the notice names the reason.
- **A plugin whose parked ref is missing or orphaned** counts as changed. The flow never guesses
  (ADR-0003, Derived tactical observations).

## Test seam

- **The Mod watcher:** given a mod folder's changes, one settle once it is quiet.
- **Commands, at a settle or at load:** given a tracked mod's plugins and what Modbench last wrote,
  the plugins that changed outside Modbench and the untracked plugins.
