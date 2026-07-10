# Mod Management

The Modbench subsystem (Loadout view) that installs, orders, enables, and deploys mods, and locates the game. Lives in the VS Code extension. Operates on files and folders, never on record internals.

## Language

**Mod**:
A distributable package of files (plugins + loose assets + archives) occupying one `mods/<name>/` folder that mirrors the game's `Data/` layout.
_Avoid_: plugin, package

**Modlist**:
The ordered, enable-able set of mods mEdit manages for a game. Later position wins file conflicts — this ordering is the **Mod load order**.
_Avoid_: load order (ambiguous — say "Mod load order")

**Plugin load order**:
The order plugins (`.esm`/`.esp`/`.esl`) are loaded by the game engine, as written in `plugins.txt`; determines which override wins at the record level (Editing context concern). Owned and written by the Plugins tab ([plugins.md](../../../docs/specs/plugins.md)); Editing consumes it read-only to build a session. Distinct from Modlist's mod load order (file-level winner).
_Avoid_: load order (ambiguous), plugin list

**Deploy** (a.k.a. Build):
Make the enabled mods' files present in the game directory so the running game reads them.
_Avoid_: install, link, mount

**Purge** (a.k.a. Teardown):
Remove deployed mod files, returning the game directory to its pre-deploy state.
_Avoid_: uninstall, clean

**Game directory**:
The game installation mEdit reads vanilla masters from and deploys into — either the Steam install or a stock game folder.
_Avoid_: data folder (that is a subpath), install path

**Stock game folder**:
A copy of the vanilla game files kept outside Steam's management, used to pin a known-compatible version and keep the real Steam install clean.
_Avoid_: game copy, vanilla folder

**File conflict**:
Two enabled mods providing the same relative file; the higher-priority mod's file wins. Distinct from a record-level conflict in the Editing context.
_Avoid_: override (override is record-level)
