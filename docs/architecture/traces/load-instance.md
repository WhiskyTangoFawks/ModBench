# load-instance: contract

Diagram: [load-instance.d2](load-instance.d2). Catalog row: `refresh` under Instance in
[commands.md](../commands.md). What the views show is in [common.md](../surfaces/common.md),
States, and [toolbox.md](../surfaces/toolbox.md), Refresh. Governed by
[ADR-0003](../../adr/0003-modbench-never-assumes-exclusive-ownership-of-a-file.md),
[ADR-0009](../../adr/0009-the-record-index-mirrors-the-files-on-disk.md),
[ADR-0012](../../adr/0012-every-plugin-in-the-instance-is-indexed.md),
[ADR-0013](../../adr/0013-mod-management-hands-editing-the-load-order.md) and
[ADR-0015](../../adr/0015-edits-reach-the-read-model-through-the-watcher.md).

The Instance loader is how every view reads the instance: one value, built from disk and nothing
else. A change from Modbench and a change from MO2 or any other tool reach it the same way
(ADR-0015, invariant 2).

## The flow

1. The Instance loader watches the instance through the globs the Instance adapter names: each
   profile's `modlist.txt` and `plugins.txt`, `ModOrganizer.ini`, `mods/`, `overwrite/` and the
   downloads folder. One debounce covers every watch, so a burst of changes is one read.
   Activation and refresh start the same read.
2. The Instance loader reads, through the Instance adapter, `ModOrganizer.ini` first: the active
   profile, the game, and where the downloads are. Then it reads the profile's `modlist.txt` and
   `plugins.txt`, each mod's `meta.ini`, the downloaded files and their `.meta` files, and the game
   folder's plugins. The Instance adapter finds the game folder: the setting first, then MO2's
   configuration, then Steam or Wine detection.
3. The Instance adapter parses each file through its codec and answers parsed values.
4. The Instance loader builds one immutable value, replaces the last value whole, and raises the
   sequence by one. No consumer holds facts from two generations (ADR-0015, invariant 6).
5. The value goes to every view, and to instance commands. Instance commands derive the load order
   snapshot from it, every plugin file in the instance (ADR-0012), and send it to mEdit
   ([index-load-order](index-load-order.md)).

## refresh

`refresh` runs the flow on purpose, for all of Modbench at once. It is a safety net, never how a
change normally arrives.

1. The Toolbox fires `refresh`. Instance commands ask mEdit, through the mEdit client, to drop and
   rebuild the index.
2. Once the rebuild lands, mEdit reads every plugin again against the load order it holds, as a cold
   load does ([ADR-0009](../../adr/0009-the-record-index-mirrors-the-files-on-disk.md), invariant 5).
   Nothing is sent.
3. The Toolbox then asks the Instance loader to read every file again, as flow step 2 does.

A refused or failed rebuild stops there: nothing is sent, and nothing is read again.

## Hand-off

This flow waits for no hand-off.

- mEdit indexes the snapshot ([index-load-order](index-load-order.md)).
- When the value disagrees with the disk, mod sync and plugin sync run on it
  ([update-load-order-file](update-load-order-file.d2)). Their writes come back through the watch.

## Refusals and failures

| Outcome | What happens |
|---|---|
| A file cannot be read or parsed | The last value stays, with its sequence, and the reason is published beside it until a read lands. One line goes to the Output. Each view keeps its rows and says so (common.md, States, story 6). |
| The first read fails | No value lands. The views show the error row (common.md, States, story 2). |
| The folder is not an instance | The views say so, and how to open one (common.md, States, story 4). |
| The game folder cannot be found | The value lands without it. No snapshot is sent, so mEdit keeps the load order it holds (common.md, States, story 5). |
| `refresh`, while another window holds the index | Refused, naming it (ADR-0009, invariant 5). |
| `refresh`, when the rebuild fails | It stops, and says why. |

## Test seam

- **The Instance loader:** given watch events and the bytes of the files, the value and its
  sequence, or the last value kept.
- **Instance commands:** given a value, the snapshot. Given `refresh`, the rebuild and nothing sent,
  or the refusal and nothing sent.
