# LOOT, and how MO2 and Vortex use it

Read from `references/loot/` (libloot `4bd551b`, loot `d56bca2`, prelude `3ae09f0`, fallout4 `22dcffe`, lootcli `465d410`), `references/modorganizer` at `efe2a02d` and `references/Vortex` at `6ffb794`. Clone the LOOT repositories from `github.com/loot` into `references/loot/` and lootcli from `github.com/ModOrganizer2/modorganizer-lootcli`.

It describes the three tools only.

## LOOT

LOOT is three things: metadata, a library and an app.

### Metadata

- One YAML schema for the masterlist, the prelude and the userlist (`libloot/docs/metadata/`). The userlist merges over the masterlist (`data_structures/plugin.rst`, Merging Behaviour). `group` is replaced only when unset. `after`, `req`, `inc` and `tag` are unions, and `msg` appends. So a userlist adds to the masterlist and never removes from it.
- A plugin entry: `name` (a regex is allowed), `group`, `after`, `req`, `inc` (lists of files), `msg`, `tag`, `url`, `dirty`, `clean`.
- A file: a name, or a map of `name`, `display`, `detail`, `condition`, `constraint` (`file.rst`).
- A group: `name`, `description`, and `after`, a set of group names (`group.rst`).
- A message: `type` (`say`, `warn`, `error`), `content` in CommonMark, `condition`, `subs` (`message.rst`).
- Conditions (`conditions.rst`): `and`, `or`, `not` over `file`, `file_size`, `readable`, `active`, `many`, `many_active`, `is_master`, `is_executable`, `checksum`, `version`, `product_version`, `filename_version`, `description_contains`. Paths are relative to Data.
- Distribution: a plain GET of `https://raw.githubusercontent.com/loot/<game>/v0.29/masterlist.yaml`, and the same for `loot/prelude` (`loot/src/gui/state/game/game_settings.cpp:107`, `game_settings.h:37`). The branch is the metadata syntax version. The content is CC0 (`fallout4/LICENSE`).
- The app keeps the userlist at `<LOOT data>/games/<folder>/userlist.yaml`, one per game on the machine (`loot/src/gui/state/game/game.cpp:111`). `<LOOT data>` is `%LOCALAPPDATA%\LOOT`, or `$XDG_DATA_HOME/LOOT` (`loot/docs/app/usage/initialisation.rst:19`).

Fallout 4's masterlist, counted at `22dcffe`:

| Entries | Count |
|---|---|
| Plugin entries | 1141, about 197 of them regex |
| with `url` | 580 |
| with `clean` | 509 |
| with `msg` | 249 (334 messages: 178 error, 69 warn, 87 say) |
| with `dirty` | 231 |
| with `after` | 180 (456 edges) |
| with `group` | 158, over 26 groups |
| with `inc` | 72 |
| with `req` | 29 |

Its conditions use `active` 234 times, `version` 89 (46 on an `.exe`), `file` 73, `checksum` 52, `many` 41, `readable` 26 and `many_active` 2. Skyrim SE's adds `is_master` and `product_version`.

### libloot

- Rust, 0.29.7, GPL-3.0-or-later (`libloot/Cargo.toml:49`). Its C++ wrapper is a class ABI built on `cxx`. It has no C ABI (`cpp/README.md`). The Python and Node wrappers are experimental and unpublished. Releases ship Windows x64 only.
- It reads `plugins.txt` and the Data folder itself, through libloadorder and esplugin (`src/game.rs`). It names a plugin by its file name, and refuses two plugins of one name (`src/game.rs:579`).
- It has no call that checks an order without sorting it. `sort_plugins` (`src/game.rs:444`) builds the graph in `src/sorting/plugins.rs:783`. Masters, requirements, load afters and hardcoded plugins are hard edges, and a cycle among them is an error that names the cycle. Groups, record and asset overlap, and the current order are soft edges. A soft edge that would make a cycle is dropped, and a dropped group edge is logged at debug only (`plugins.rs:1133`).
- The calls besides sorting: `plugin_metadata(name, merge, evaluate)`, `general_messages`, `evaluate(condition)`, `groups_path` (`src/database/mod.rs`).

### The app

Every per-plugin warning is the app's, not libloot's: `checkInstallValidity` in `loot/src/gui/state/game/validation.cpp:768`. It warns of a missing requirement for an active plugin, an incompatibility that is present and active, masters that are missing or inactive (`:504`), invalid light, medium and update flags, an undefined group, and plugin limits (`:881`). No check names a plugin that loads before its master, or a load after the user's order breaks.

## MO2

- Sort runs `<MO2>/loot/lootcli.exe` under USVFS, so libloot sees the virtual Data folder (`modorganizer/src/loot.cpp:467-494`). lootcli loads the masterlist and the global userlist but no prelude, sorts, and writes a JSON report and the sorted list to `%TEMP%` (`lootcli/src/lootthread.cpp:674-852`). It has no mode that skips the sort.
- A dialog shows the whole sorted list, with no diff. Apply moves the sorted list over the profile's `loadorder.txt`. Cancel keeps the order (`lootdialog.cpp:264-333`). Online, nothing confirms the sort (`pluginlistview.cpp:184`).
- The report goes into an in-memory map keyed by file name, kept until the next run or a restart. Cancel keeps it too (`lootdialog.cpp:291`, `pluginlist.h:415`). The plugin list shows it as a tooltip and as icons in the Flags column (`pluginlist.cpp:1665-1808`).
- MO2 never edits a userlist.
- On every refresh MO2 moves the plugins with the master flag above those without it, puts blueprint plugins last, and moves each plugin below its masters, and says nothing (`fixPluginRelationships`, `pluginlist.cpp:387-456`). A drag is clamped to the same rules (`setPluginPriority`, `:1927`). Locked plugins keep their index (`lockedorder.txt`, `:697-962`).

## Vortex

- The `loot` node package (`Nexus-Mods/node-loot`, libloot 0.29) runs in a forked process, on Windows only (`extensions/gamebryo-plugin-management/src/autosort.ts:843-938`).
- The user's plugin rules are LOOT's userlist, exactly as LOOT writes it: `%APPDATA%/Vortex/<game>/userlist.yaml`, written whole with js-yaml (`util/UserlistPersistor.ts:74,145`). The `local_loot_rules` feature keeps a copy for each profile at `<game>/profiles/<id>/userlist.yaml` (`src/index.ts:497,774-838`). Vortex keeps its own masterlist and prelude under `%APPDATA%/Vortex/` (`util/masterlist.ts:5`, `autosort.ts:125`). A rewrite drops comments and anchors.
- Autosort is on by default and runs after each deploy. Sort Now sorts with autosort off (`reducers/settings.ts:20`, `autosort.ts:182`). A cycle cancels the sort and opens a dialog that names each edge and offers to remove user rules on the path (`autosort.ts:961-1313`).
- With autosort off, LOOT's messages, cleaning data, groups, requirements and incompatibilities still show (`PluginList.tsx:588-616`). Requirements and incompatibilities are checked for presence by Vortex, with their conditions ignored (`src/index.ts:1492-1640`). No code checks an order against load afters or groups.
- Mod rules (before, after, requires, conflicts) are a separate system on each mod. They decide which mod's files win (`src/renderer/src/extensions/mod_management/util/sort.ts`), and libloot never sees them.
