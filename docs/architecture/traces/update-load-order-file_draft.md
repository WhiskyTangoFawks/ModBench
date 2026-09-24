# update-load-order-file: contract (draft)

Diagram: [update-load-order-file.d2](update-load-order-file.d2). Fifteen commands draw one shape: a
driving box calls a Core box, the codec splices, the Instance adapter puts the bytes, and the watch closes the
loop. The two actors that differ are drawn as sets, and the table below says which command uses which. Governed by
[ADR-0003](../../adr/0003-modbench-never-assumes-exclusive-ownership-of-a-file.md),
[ADR-0013](../../adr/0013-mod-management-hands-editing-the-load-order.md),
[ADR-0015](../../adr/0015-edits-reach-the-read-model-through-the-watcher.md),
[ADR-0016](../../adr/0016-mod-management-lives-in-the-extension.md) and
[ADR-0017](../../adr/0017-mo2-is-the-reference-for-mod-management.md).

Each story cites its source: a principle in [commands.md](../commands.md), an ADR, the catalog or the
diagram. **Ruling** means the maintainer decided it and nothing else states it.

## What each command writes

| Command | Core box | Writes |
|---|---|---|
| mod `enable` / `disable`, `move` | modlist commands | `modlist.txt` |
| separator `add`, `rename`, `delete` | modlist commands | `modlist.txt`, and the separator's folder |
| mod `uninstall` | modlist commands | `modlist.txt`, the mod folder, and the downloaded file's `.meta` |
| mod `create empty mod` | modlist commands | `modlist.txt`, and an empty mod folder |
| `mod sync` | modlist commands | `modlist.txt` |
| plugin `enable` / `disable`, `move` | plugins commands | `plugins.txt` |
| `plugin sync` | plugins commands | `plugins.txt` |
| profile `switch` | instance commands | `ModOrganizer.ini` |
| downloaded file `exclude` / `include`, `delete` | downloads commands | a download's `.meta`, and the file |

## Shared

True of every command in this file.

As a user, I want:

1. Only the bytes the gesture names to change. Comments, blank lines, line endings and anything
   Modbench does not manage survive. *ADR-0017, invariant 2*
2. The command to write and keep no copy. Every view updates when the watch reads the file back, so a
   view shows the old state until the disk says otherwise. *A write is forgotten; ADR-0015, invariant 2*
3. A change I make in MO2 to show the same way, through the same watch. *ADR-0015, invariant 2*
4. An object that has gone from disk to be refused, naming it, with nothing written. *A gone object is
   refused; ADR-0003*
5. A failure to leave the file as it was, and to tell me why. *A failed gesture writes nothing;
   ADR-0019*
6. Nothing written when the result equals what is already there. *Doing nothing is not an error*
7. No confirmation, unless a section below says otherwise. *Confirm what destroys*
8. Esc on any picker or prompt to change nothing. *Esc changes nothing*
9. No Core box to read the Instance loader. A value a command needs arrives as its argument. *the
   architecture: "No command reads the Instance loader"*
10. A system command's failure reported once when it begins, and again only when its reason
    changes. A recompute that meets the same failure adds nothing. *One failure is one line,
    [common.md](../surfaces/common.md#states), story 2*

## mod enable / disable

1. Each selected mod's line flipped. *catalog Meaning*
2. Enable all to be select all, then enable. *catalog Meaning*

## mod move

1. Mods and separators moved in mod order. *catalog Meaning*
2. A target that is not a valid place refused, and nothing moved. A drop there changes nothing and
   says nothing instead ([mods.md](../surfaces/mods.md), Drag and drop). *Refuse, do not repair*

Options: a separator (built). Top, bottom, priority N, and first or last conflict are planned.
*catalog Options*

## separator add, rename, delete

1. A separator added above the mod I chose, which joins it, or below the separator I chose, after its
   mods. *catalog Options*
2. A separator renamed. *catalog Meaning*
3. A deleted separator to leave its mods in place. They join the separator above, or become ungrouped
   when it was the first. *catalog Meaning*
4. A separator to be MO2's: a folder, `mods/<name>_separator/`, beside its line. Add makes the folder,
   rename renames it, and delete removes it, so MO2 keeps the separator. *ADR-0017, invariant 1; MO2*
5. A name another separator has refused, naming it: "A separator with this name already exists".
   *MO2*

## mod uninstall

1. The mod's folder moved to the system trash, then its line removed. A failed trash changes nothing
   and says why. A line left after the trash is a line whose folder is gone, which the next watch
   hands to `mod sync`. *catalog Meaning; MO2's recycle bin; ADR-0015, invariant 2*
2. To be asked first. *Confirm what destroys*
3. The downloaded file it was installed from marked uninstalled in its `.meta`, so MO2's Downloads
   tab agrees. A failure there does not fail the uninstall; it is a line in the Output. *ADR-0017,
   invariant 1; [downloads.md](../surfaces/downloads.md)*

## mod create empty mod

1. An empty mod folder and its line created, with no `meta.ini`. *catalog Meaning*
2. A prompt for the name. *The surface supplies the Argument, a picker supplies the Options*

## mod sync

The trigger is the active profile's `modlist.txt` disagreeing with `mods/`: a folder with no line, or
a line whose folder is gone. Both directions land in one write.

1. A line added for each folder in `mods/` that has none. *catalog Meaning*
2. Each line whose folder is gone from `mods/` removed, so the mod leaves the list. *ruling; MO2's
   refresh*
3. The same path for a folder added or removed by hand, by MO2 or by any other tool. *ADR-0015,
   invariant 2*
4. No prompt and no notification when it works. The rows are the result. *ADR-0019*
5. When `mods/` cannot be listed, nothing added and nothing removed, and the reason in the Mods
   view's message line and in the Output. *A failed gesture writes nothing; ADR-0019, the background
   tier*

## plugin enable / disable

1. Each selected plugin's line flipped. *catalog Meaning*
2. It offered only for a plugin that has a line. A plugin the game loads with no line is shown
   locked. *catalog Meaning; No dead entries*
3. Enable all to be select all, then enable. *catalog Meaning*

## plugin move

1. Plugins moved in plugin order. *catalog Meaning*
2. A move that puts a master below a plugin that depends on it, or a blueprint plugin before a
   non-blueprint one, refused with the plugin's name. Nothing moves. *catalog Meaning; Refuse, do not
   repair*
3. A drop that is not a valid place refused, and nothing moved. *Refuse, do not repair*

## plugin sync

The trigger is `plugins.txt` disagreeing with the plugins provided: a plugin on disk with no line, or
a line that nothing provides. Both directions land in one write. It runs on each new instance value,
and again when mEdit connects, so a value that arrived before mEdit could answer is still synced.

1. A plugin found on disk with no line added at the end, disabled. *ADR-0017; MO2's plugin list adds a
   plugin it has not seen as not enabled, at the end*
2. Vanilla plugins the game loads with no `plugins.txt` line left out, even when a mod ships a copy.
   *ADR-0013 and ADR-0016: mEdit answers which plugins load with no line*
3. A line that nothing provides removed. Provided means a plugin at the root of an enabled mod, in
   `overwrite/`, or the game folder's copy. *ADR-0003; ADR-0013*
4. When mEdit cannot answer, or a folder cannot be listed, nothing added and nothing removed, and the
   reason in the Plugins view's message line and in the Output. *A failed gesture writes nothing;
   ADR-0019, the background tier; [plugins.md](../surfaces/plugins.md), Reporting* A game folder
   that is not found is a folder that cannot be listed.
5. No prompt and no notification when it works. The new rows are the result. *ADR-0019*

## profile switch

1. A list of the profiles when I give none. *catalog Meaning*
2. The profile line in `ModOrganizer.ini` changed, so `modlist.txt` and `plugins.txt` come from the new
   profile, with nothing torn down. *catalog Meaning; ADR-0015, invariant 7*

## downloaded file exclude / include

1. A download's `.meta` marked hidden, or the mark cleared. *catalog Meaning*
2. A selection that mixes excluded and included rows to take the clicked row's direction.
   *[downloads.md](../surfaces/downloads.md)*

## downloaded file delete

1. The file and its `.meta` moved to the system trash, the file first. A failure on the file writes
   nothing; a failure on the `.meta` after it leaves a lone `.meta`, which no view shows, so the
   delete is done. *A failed gesture writes nothing; [downloads.md](../surfaces/downloads.md)*
2. To be asked first, once for the whole selection. *Confirm what destroys*
3. The mod it installed left in place. *[downloads.md](../surfaces/downloads.md)*

## Test seam

Two seams, one per side of the driving boundary.

- **The driving box** (Mods, Plugins, Toolbox, Downloads): what is offered, the pickers, the prompts, the
  confirmations, and Esc.
- **The Core box** (modlist, plugins or instance commands): given an argument and the current bytes,
  the bytes it puts through the Instance adapter, or the refusal.

## Open Questions

1. **Separator delete.** It removes a line, and no mod is lost. Should it ask first? I applied Confirm
   what destroys and did not write a confirmation story.
2. **Where a mod lands in a separator.** The old spec says the end of that section. Accept?
3. **Mod order and ends.** ADR-0017 says the top of `modlist.txt` is the winning end. The old spec says
   an installed mod lands "at the bottom". I did not use it.
4. **Removing a `plugins.txt` line.** `plugin sync` removes a line that nothing provides. That
   destroys data, and it is a system command, so nobody can be asked. Does Confirm what destroys reach
   system commands, or is a line nothing provides not a destruction?
5. **`.mohidden` files.** The old spec says they do not count as provided. MO2 ships `.mohidden` in a
   list of suffixes it skips. I could not confirm what consumes that setting, so I left it out.
6. **Order among several new plugins.** Not specified anywhere. No test may assert one.
7. **Vanilla plugins with a line.** The old spec says such a line toggles like any other, with no
   guard-rail, and the badge reports the fallout. `mo2.md` has no row for it. Add one?
8. **Which box refuses a gone object.** I assumed the Core box checks, because it holds the file. The
   diagrams draw no check.
9. **Uninstall and the plugin line.** Uninstalling the only provider of a plugin leaves its
   `plugins.txt` line for `plugin sync` to remove. Is that intended?
