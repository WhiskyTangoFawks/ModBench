# update-load-order-file: contract (draft)

Diagram: [update-load-order-file.d2](update-load-order-file.d2). Catalog rows under Mod, Separator,
Plugin, Profile and Downloaded file, and the system commands `mod sync` and `plugin sync`, in
[commands.md](../commands.md); the table below names each. What the user picks, types and confirms
is in [mods.md](../surfaces/mods.md), [plugins.md](../surfaces/plugins.md),
[toolbox.md](../surfaces/toolbox.md) and [downloads.md](../surfaces/downloads.md). Governed by
[ADR-0003](../../adr/0003-modbench-never-assumes-exclusive-ownership-of-a-file.md),
[ADR-0013](../../adr/0013-mod-management-hands-editing-the-load-order.md),
[ADR-0015](../../adr/0015-edits-reach-the-read-model-through-the-watcher.md),
[ADR-0016](../../adr/0016-mod-management-lives-in-the-extension.md) and
[ADR-0017](../../adr/0017-mo2-is-the-reference-for-mod-management.md).

Every command here changes one instance file, and a folder where the table says so, then forgets
it. The watch reads the change back, so a change from MO2 or any other tool takes the same path
(ADR-0015, invariant 2).

## The flow

1. A driving box sends the gesture to its Core box, with its Argument and Options. A system command
   gets the instance value from the Instance loader as its Argument. No Core box reads the Instance
   loader itself.
2. Plugins commands ask the mEdit client which plugins the game loads with no line, and, for a
   move, which masters each plugin has. An unreachable mEdit answers that it cannot say.
3. Under one lock per file, the Core box reads the file as it is now and splices it through the
   codec. Only the bytes the command names change: comments, blank lines, line endings, the byte
   order mark and every line Modbench does not manage survive (ADR-0017, invariant 2). A result
   equal to the file writes nothing.
4. The Instance adapter replaces the file whole, through a temporary file and a rename, then
   forgets it. It also makes, renames and trashes the folders the table names.
5. The Core box answers per item: applied, or the refusal.

| Command | Core box | What changes |
|---|---|---|
| mod `enable` / `disable` | modlist commands | Each mod's line flips. |
| mod `move` | modlist commands | The lines move as one block: into a separator as its first mods, or directly above a mod ([mods.md](../surfaces/mods.md)). |
| separator `add` | modlist commands | A line, and the folder `mods/<name>_separator/`: above a mod, which joins it, or after a separator's last mod. |
| separator `rename` | modlist commands | The line, and the folder with it. |
| separator `delete` | modlist commands | The line goes, and the folder goes to the trash. Its mods join the separator above, or become ungrouped. |
| mod `uninstall` | modlist commands | The mod's folder goes to the trash, then its line goes. The downloaded file it came from is marked uninstalled in its `.meta`, for MO2's Downloads tab (ADR-0017, invariant 1). |
| mod `create empty mod` | modlist commands | A folder, then a line at the winning end, disabled. |
| `mod sync` | modlist commands | A line for each folder in `mods/` that has none, at the winning end, disabled. Each line whose folder is gone is dropped. One write. |
| plugin `enable` / `disable` | plugins commands | Each plugin's line flips. |
| plugin `move` | plugins commands | The lines move as one block. |
| `plugin sync` | plugins commands | A line for each provided plugin that has none, at the end, disabled. Each line that nothing provides is dropped. One write. |
| profile `switch` | instance commands | The selected profile in `ModOrganizer.ini`. |
| downloaded file `exclude` / `include` | downloads commands | The file's `.meta` hidden flag, set or cleared. A file with no `.meta` gets one. |
| downloaded file `delete` | downloads commands | The file goes to the trash, then its `.meta`. The mod it installed stays. |

A plugin is provided when a plugin file sits at the root of an enabled mod, in `overwrite/`, or in
the game folder. A plugin the game loads with no line never earns one, even when a mod ships a copy
(ADR-0013; ADR-0016). A disabled mod provides nothing, so disabling a mod drops its plugins' lines,
and enabling it again adds them at the end: their place in plugin order is lost, as in MO2.

When one write adds several lines, their order is not set, and no test may assert one. The user
orders them.

## Hand-off

This flow waits for no hand-off. The Instance loader's watch reads the file back and builds the next
value ([load-instance](load-instance.md)). Every view renders it, and a changed load order goes on
to mEdit ([index-load-order](index-load-order.md)). A value that disagrees with the disk runs the
two syncs again, so an uninstalled mod's plugin line is dropped by `plugin sync`.

## Refusals

The Core box refuses before it writes, and names the cause.

| Refusal | Where | Why |
|---|---|---|
| The object has gone: a mod, a separator, a plugin line or a downloaded file, naming it | every gesture | A gone object is refused. |
| A name another mod or separator has, naming it | `create empty mod`, separator `add` and `rename` | MO2 keys both by name. |
| A master below a plugin that depends on it, or a blueprint plugin before one that is not, naming both | plugin `move` | When mEdit cannot say, the move lands ([plugins.md](../surfaces/plugins.md)). |
| A target that is not a valid place | mod `move`, plugin `move` | A drop there changes nothing and says nothing: the surface never sends it. |
| The trash fails, naming the item | `uninstall`, separator `delete`, downloaded file `delete` | Nothing more is written for that item. |
| `mods/` cannot be listed | `mod sync` | Nothing is written. The reason goes to the Mods view's message line and the Output. |
| mEdit cannot say which plugins load with no line, or a folder cannot be listed, the game folder included | `plugin sync` | Nothing is written. The reason goes to the Plugins view's message line and the Output. |

A system command reports a failure once when it begins, and again only when its reason changes
([common.md](../surfaces/common.md), States, story 2).

## Failure

A failed write leaves the file as it was.

Exceptions to the principles:

- **A failed gesture writes nothing.** `uninstall` writes the folder, the line and the `.meta`. When
  the line fails after the trash, the line names a folder that is gone, and `mod sync` drops it. A
  failed `.meta` mark is a line in the Output, and the uninstall stands. A downloaded file `delete`
  whose `.meta` fails after the file leaves a lone `.meta`, which no view shows
  ([downloads.md](../surfaces/downloads.md), Reporting).

## Test seam

- **The Core box:** given the Argument, or the instance value, and the file's current bytes, the
  bytes it puts and the folders it makes, renames or trashes, or the refusal and nothing written.
