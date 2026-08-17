# Mod Management

The Modbench subsystem (Loadout view) that installs, orders, enables, and deploys mods, and locates the game. Lives in the VS Code extension. Operates on files and folders, never on record internals.

## Language

**Mod**:
A distributable package of files (plugins + loose assets + archives) occupying one `mods/<name>/` folder that mirrors the game's `Data/` layout.
_Avoid_: plugin, package

**Authored mod**:
A mod the user owns outright — created in Modbench, or adopted — with no upstream it derives from. The only kind of mod whose full content may be shared.
_Avoid_: custom mod, personal mod, own mod

**Downloaded mod**:
A mod installed from a Download or any other external source; the upstream defines the pristine content it derives from. Ownership, not transport, is the split — a mod installed from someone else's git repository is still a Downloaded mod.
_Avoid_: third-party mod, external mod

**Modified**:
The state of a Downloaded mod whose files have diverged from what its upstream installed. Derived by comparison, never declared — a mod drifts into this state by being edited and out of it by being reverted. Only the divergence, never the full content, may be shared.
_Avoid_: "modified mod" as a kind, edited mod, tweaked mod

**Adopt**:
Take ownership of a Modified mod: reclassify it as Authored and sever the upstream link. One-way — for when tracking a divergence stops being honest because the mod is more the user's work than the upstream's.
_Avoid_: fork, convert

**Download**:
A single distributable file sitting in the instance's shared `downloads/` folder (`.zip`/`.7z`/`.rar`), with an optional MO2-written `.meta` sidecar carrying its Nexus metadata. A download is the **uninstalled state of a mod**: installing one produces a `mods/<name>/` folder, and the two are linked only derivably, via the installed mod's `meta.ini` `installationFile` — never by stored state on the download. The relationship is many-to-many (one download can be installed into several mods; a merged mod can come from several downloads), so no download "belongs to" a mod.
_Avoid_: archive (that is BA2/BSA — see **Mod**), package

**Download status**:
A download's install state, read from its `.meta`: **Downloaded** (neither flag), **Installed** (`installed=true`), **Uninstalled** (`uninstalled=true`). Strictly orthogonal to **Hidden** below — the two are derived from different keys and are never conflated.
_Avoid_: Removed (MO2's `.meta` key `removed` means *hidden*, so "Removed" collides with the other axis; MO2 itself displays "Uninstalled")

**Hidden**:
A download the user has dismissed from view (`.meta` `removed=true`). A display axis only — it says nothing about whether the download was ever installed, and carries no Download status of its own. Hidden downloads are absent from the Downloads view unless *Show hidden* is on.
_Avoid_: removed, deleted (the file is still on disk)

**Modlist**:
The ordered, enable-able set of mods mEdit manages for a game. Its ordering is the **Mod override order** (below).
_Avoid_: load order (ambiguous — say "Mod override order")

**Override order**:
The semantic ordering that decides who wins a conflict. Defined **only** by its two ends — never by position in a file or a view. Two instances:

- **Mod override order** (Modlist priority, `modlist.txt`) — decides **file** conflicts (which mod's loose file the game sees).
- **Plugin override order** (a.k.a. Plugin load order, `plugins.txt`) — decides **record** conflicts (which plugin's version of a record wins); the game loads plugins in this order.

_Avoid_: "higher/lower priority"; "load order" unqualified.

**Winning / Losing**:
The two ends of an override order. "A **wins over** B" / "B **loses to** A"; the extremes are **winning-most** and **losing-most**. Anchor invariant: **vanilla content is losing-most on every axis** — `Fallout4.esm`'s records lose to every plugin; vanilla `Data/` files lose to every mod. `overwrite/` is winning-most on the Mod axis. This invariant, not any file/view position, is what makes an override order _correct_.
_Avoid_: high/low priority, top/bottom (those are view words).

**View order**:
How a list is displayed (winning-at-top or losing-at-top). A configurable presentation choice with **no** semantic weight — it never changes who wins. Keep strictly separate from override order.
_Avoid_: conflating with priority/override order.

**Separator**:
A named label that **wraps** a contiguous run of mods in the Mod override order — an author's grouping ("ENB", "Armor"), not a participant in it. A separator does not win or lose anything; it has no files. Its membership is **fixed and view-independent**: a mod belongs to the same separator no matter which way the list is displayed. In `modlist.txt` a separator's wrapped mods are the entries **preceding** its line, up to the previous separator — the mods that win over it — because the file is winning-first while MO2's authoring view is losing-at-top, so a separator is written *after* the mods it heads. Mods after the last separator in the file (the losing end) are **ungrouped**. See #107.
_Avoid_: group/category (say separator), "the mods under a separator" without saying in which order, treating a separator as a priority position.

**Plugin load order**:
The **Plugin override order** as written in `plugins.txt` — the order the game engine loads plugins (`.esm`/`.esp`/`.esl`); the last-loaded wins at the record level and base masters (`Fallout4.esm`) are losing-most (Editing context concern). Owned and written by the Plugins tab ([plugins.md](../../../docs/specs/plugins.md)); Editing consumes it read-only to build a session. Distinct from the Mod override order (file-level winner).
_Avoid_: load order (ambiguous), plugin list, higher/lower priority (say "winning"/"losing")

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
Two enabled mods providing the same relative file; the **winning** mod's file wins (the one nearer the winning end of the Mod override order). Distinct from a record-level conflict in the Editing context.
_Avoid_: override (override is record-level); higher-priority (say "winning")
