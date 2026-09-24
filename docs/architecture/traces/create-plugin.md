# create-plugin: contract

Diagram: [create-plugin.d2](create-plugin.d2). Catalog row: `create` under Plugin in
[commands.md](../commands.md). What the user picks and types is in
[plugins.md](../surfaces/plugins.md), Create plugin. Governed by
[ADR-0003](../../adr/0003-modbench-never-assumes-exclusive-ownership-of-a-file.md),
[ADR-0007](../../adr/0007-plugin-edits-are-git-working-tree-changes.md),
[ADR-0012](../../adr/0012-every-plugin-copy-is-indexed.md),
[ADR-0013](../../adr/0013-mod-management-hands-editing-the-load-order.md),
[ADR-0015](../../adr/0015-edits-reach-the-read-model-through-the-watcher.md) and
[ADR-0017](../../adr/0017-mo2-is-the-reference-for-mod-management.md).

## The flow

1. Plugins sends the new plugin to Commands, through the mEdit client and the HTTP endpoints: its
   origin, its file name and its folder. The origin is Overwrite, or the enabled mod the user
   picked. The origin and the file name together are the plugin (ADR-0012, invariant 1).
2. Commands takes the game release from the load order snapshot it holds.
3. Commands asks the Plugin adapter for an empty plugin in that release: a header, no records and
   no masters. The extension sets the header flags: `.esm` is a master, `.esl` is a light plugin,
   and `.esp` is neither.
4. The Plugin adapter writes the file whole or not at all, then forgets it.
5. Commands answers applied, or the refusal. It changes nothing else: no `plugins.txt` line, no
   load order snapshot, no source tree and no git. The new plugin is untracked (ADR-0007,
   invariant 2).

## Hand-off

This flow waits for no hand-off.

- The Instance loader's watch finds a plugin on disk with no `plugins.txt` line. From there the
  flow is plugin sync in [update-load-order-file](update-load-order-file.d2), which adds the line
  at the end, disabled. Then [index-load-order](index-load-order.d2) indexes the plugin.
- In a tracked mod, the Mod watcher finds a plugin that the mod's repository does not track. From
  there the flow is the trigger of [decompile-plugin](decompile-plugin.d2), which warns. Tracking
  it is the user's gesture.

## Refusals

Commands refuses before any write, and names the cause.

| Refusal | Why |
|---|---|
| No load order snapshot is held | The release is not known. |
| The folder has gone | A gone object is refused. Create never makes a folder. |
| A file exists at the path | Modbench never assumes it owns a file (ADR-0003). |
| The name ends `.esl` and the release has no light plugins | The game cannot load it. |

## Failure

The flow writes one file. A failed write leaves no file. No principle has an exception.

## Test seam

- **In:** an origin, a file name and a folder; a held load order snapshot, or none; what is on
  disk at the path.
- **Observed:** the file's header flags, records and masters, or the refusal and no file. Nothing
  else on disk or in the held snapshot changes.
