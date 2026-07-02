# Modbench-6 — Mod installation from archive/folder (was M-5)

**Status: In Progress**
**Recommended model: Sonnet 4.6** — mostly mechanical (extract, detect root, normalize, write `meta.ini`); the only judgment call is the archive-lib decision, which is bounded.

## Decisions (planning)

- **Extraction:** shell out to the system `7z` binary (`node:child_process`) — no new npm dep, covers zip/7z/rar. Tries `7z`/`7za`/`7zz`; if none is on `PATH`, an actionable error asks the user to install p7zip-full.
- **New mod position:** appended at the **bottom** of `modlist.txt` (lowest priority), disabled.
- **FOMOD:** installed like a normal mod but **flagged** with a warning — the scripted-installer wizard is a separate future sub-project. (This softens the original "not auto-installed" test wording; see Tests.)
- **UI deferred:** the two commands are registered and invokable from the **Command Palette**; the visible view-title button waits until the mod-tab surface is settled. `UI_SPEC.md` is untouched for now.

*Goal: install a mod from a local archive or folder into an MO2-format mod folder.*

Spec: [mod-manager.md](../mod-manager.md) (Feature Specs §1 "Mod Installation"). Prereq: Modbench-2. Effort: ~1 wk.

## Extension

- [x] "Install from Archive…" (`.zip`/`.7z`/`.rar`) and "Install from Folder…" (Command Palette; view-title button deferred).
- [x] Extract to a temp staging directory (`install/extractArchive.ts`, cleaned up in `finally`).
- [x] Detect root type (`Data/` subfolder vs `.esp`/meshes at root, plus single-wrapper peel) and normalise to a flat mod folder (`install/detectRoot.ts`).
- [x] Write `mods/<name>/` + `meta.ini` via the active `IModlistSource.installMod`; append to the profile's `modlist.txt` as disabled. (Nexus id/version unknown for a local install — deferred to Modbench-7.)
- [x] FOMOD detection — `detectRoot` flags `fomod/ModuleConfig.xml`; the command warns the user. Scripted installer left to the separate sub-project.

## Open question

Archive extraction: Node has no native 7z/RAR — shell out to `7z` or use a Node archive lib. **Decided:** shell out to the system `7z` binary (see Decisions above).

## Tests

- [x] Unit: archive with a `Data/` root and archive with files at root both normalise to a flat `mods/<name>/` (`install/detectRoot.test.ts`).
- [x] Unit: install writes `meta.ini` and appends a disabled line to `modlist.txt` (`mo2/Mo2ModlistSource.test.ts` — `installMod`).
- [x] Unit: a FOMOD archive is **flagged** (`detectRoot` reports `isFomod`) — and, per the decision above, still installed normally rather than blocked.

## Proof

*To be filled in on completion. Paste `npm run test:unit` output and commit hash here.*
