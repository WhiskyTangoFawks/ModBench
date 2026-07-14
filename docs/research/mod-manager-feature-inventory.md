# Mod Manager Feature Inventory — MO2 / Vortex / Modbench

A survey of Mod Organizer 2 and Vortex feature surfaces, mapped to Modbench's current status. This seeds the surface specs in [docs/specs/](../specs/) and the epics on [GitHub Milestones](https://github.com/WhiskyTangoFawks/ModBench/milestones).

**Status legend:** ✅ exists · 🔜 planned (tracked issue) · ❓ open question (needs a grilling session) · ➖ out of scope / covered natively by VS Code

## Mod management (Mods surface — [docs/specs/mods.md](../specs/mods.md))

| Feature | MO2 | Vortex | Modbench |
|---|---|---|---|
| Install from archive / folder | ✓ | ✓ | ✅ modbench-6 (zip/7z, root-type detection) |
| FOMOD scripted installers | ✓ | ✓ | ❓ detected and flagged only; full installer is a significant sub-project |
| Enable/disable mods | ✓ | ✓ | ✅ checkbox → `modlist.txt` |
| Manual priority ordering | ✓ drag-drop | ✗ (rule-based instead) | ✅ drag-drop, MO2 semantics (top = highest priority) |
| Separators / categories | ✓ separators | ✓ groups | ✅ separators (create/rename/delete/move-to, block drag) |
| File-conflict detection | ✓ winning/losing flags, per-file hiding | ✓ per-mod conflict views, rule drag-drop | ✅ badges + hover (winner map); per-file hiding ❓ |
| Profiles | ✓ per-instance, per-profile saves/INIs | ✓ | ✅ switcher (quick pick, persists `selected_profile`); per-profile saves/INIs ❓ deferred |
| Instances | ✓ instance manager | per-game | ➖ workspace root **is** the MO2 instance — VS Code "Open Folder" is the instance manager |
| Deployment | USVFS (API hooking, Windows-only) | Hardlinks from staging | ✅ hardlinks (Vortex approach) + purge manifest; symlink fallback for cross-volume |
| Overwrite folder | ✓ dedicated handling, "move to mod" | n/a (writes land in staging) | ❓ purge collects strays to `mods/overwrite/`; no UI to reassign/discard yet |
| Tool launcher / dashboard | ✓ executables list | ✓ dashboard dashlets | ➖ mostly covered by VS Code tasks/launch; Launch Game command ✅ |
| Mod merging (assets) | ✓ | ✗ | ❓ plugin-level merge is Phase 14 (Editing); asset-folder merge unplanned |
| Problem detection | missing masters, overwrite files, form-43, SE plugins | similar + BSA/BA2 compat | ✅ missing master/missing mod badges; broader checks ❓ |

## Downloads (planned surface — [docs/specs/downloads.md](../specs/downloads.md))

| Feature | MO2 | Vortex | Modbench |
|---|---|---|---|
| `nxm://` handler ("Download with manager") | ✓ | ✓ | 🔜 modbench-7 |
| Download queue UI with progress | ✓ Downloads tab | ✓ | 🔜 modbench-7 (status-bar + quick pick per current spec; tab-like tree ❓) |
| Install from download | ✓ double-click | ✓ | 🔜 modbench-7 ("Install now?" → modbench-6 flow) |
| Nexus account login / API key | ✓ | ✓ (first-party) | 🔜 modbench-7 (`vscode.SecretStorage`) |
| Update-available check | ✓ | ✓ | 🔜 modbench-8 (`meta.ini` version vs Nexus) |
| Endorsements / mod tracking | ✓ | ✓ | ❓ |
| Premium vs free download links | ✓ | ✓ | 🔜 modbench-7 open question (direct CDN vs redirect) |
| Collections | ✗ | ✓ browse + install + author | ➖ long-term idea only; but note Modbench's angle — a modlist repo under git *is* a shareable collection |

## Plugins / load order (surface resolved by ADR-0027; tracked in milestone 1 / #7)

| Feature | MO2 | Vortex | Modbench |
|---|---|---|---|
| Plugin enable/disable + reorder | ✓ Plugins tab | ✓ Plugins page | 🔜 modbench-9 (writes `plugins.txt`) |
| LOOT auto-sort | ✓ one-click, full masterlist | ✓ built-in, native grouping | 🔜 modbench-9 = dependency-only topological sort; full LOOT masterlist ❓ |
| ESL flags / capacity display | ✓ | ✓ | ❓ ESL convert is Phase 14 (Editing); display in a Plugins surface undecided |
| Missing-master warnings | ✓ | ✓ | ✅ (badge, via `MasterReader`) |
| Rule-based ordering (after/before rules) | ✗ | ✓ | ➖ MO2 explicit-order model chosen ([MM ADR-0001](../../modbench/src/modmanager/docs/adr/0001-mo2-native-modlist-format.md)) |

## Other MO2/Vortex surfaces

| Feature | MO2 | Vortex | Modbench |
|---|---|---|---|
| Data tab (merged virtual view) | ✓ | ✗ | ❓ deploy manifest + conflict index have the data; no merged-tree surface |
| Saves tab (per-profile saves) | ✓ | ✓ | ❓ unplanned; pairs with per-profile isolation question |
| Archives tab (BSA/BA2 list, extract) | ✓ extract, conflict detect | ✗ | ❓ unplanned; BA2s deploy as ordinary files today |
| INI editor (per-profile INIs) | ✓ | ✗ | ❓ deferred; VS Code *is* a text editor — likely just needs profile-aware file resolution |
| Record/plugin editing (xEdit) | ✗ (launches external xEdit) | ✗ | ✅ **mEdit — Modbench's core differentiator; neither manager has this** |
| Extensions / plugin API | ✓ C++/Python | ✓ JavaScript | ➖ VS Code extension ecosystem is the platform |
| Other-manager import | MO1/NMM | ✗ | ✅ MO2 instances open in place (no import needed); Vortex read-only snapshot deferred |
| Multi-game breadth | Bethesda titles | 250+ games | 🔜 all Mutagen-supported Bethesda games (multi-game-enablement); non-Bethesda ➖ |

## Structural deltas worth remembering

- **Deployment**: Modbench already took Vortex's side of the USVFS-vs-hardlinks fork (rationale in [docs/specs/mods.md](../specs/mods.md), [ADR-0022](../adr/0022-extension-owns-backend-lifecycle.md)). Editing never requires deploy.
- **Vortex compatibility**: Vortex has no simple text modlist; its staging + `vortex.deployment.json` manifest supports at best a read-only adapter. Full Vortex management remains out of scope unless demand appears.
- **VS Code-native substitutions**: several MO2 surfaces dissolve into the platform — instance manager → Open Folder; tool launcher → tasks; INI editor → the editor itself; extensions → VS Code extensions. A "tab" is only worth building where VS Code has no native equivalent (Downloads queue, mod tree, record editor).

## Sources

- [MO2 Mod Managers Comparison (official wiki)](https://github.com/ModOrganizer2/modorganizer/wiki/Mod-Managers-Comparison)
- [MO2 Changelog](https://github.com/ModOrganizer2/modorganizer/wiki/Mod-Organizer-2-Changelog)
- [Mod Manager Fundamentals (MO2)](https://www.nexusmods.com/skyrimspecialedition/articles/11684)
- [Mod Manager Fundamentals (Vortex)](https://www.nexusmods.com/skyrimspecialedition/articles/11685)
- [Vortex — about page](https://www.nexusmods.com/site/about/vortex)
- Deployment-model research previously captured in `docs/mod-manager.md` (now folded into `docs/specs/mods.md`)
