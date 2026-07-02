# Modbench-4 — Game Directory & Deployer (standalone mode) (was M-3)

**Status: Complete**
**Recommended model: Sonnet 4.6** — clearly specified, but watch the filesystem edge cases (never overwrite vanilla, cross-volume fallback, crash-recovery via manifest); escalate to Opus if those get hairy.

*Goal: let the game run with mods — hardlink the merged view into the game directory's `Data/`, purge it back out, launch the game. Standalone mode only; hidden when an external manager (MO2/Vortex) owns deployment.*

Spec: [mod-manager.md](../mod-manager.md) ("Game directory & stock game folder", "Deployment Model: Hardlinks", Feature Specs §4 Deploy/Purge/Launch). Prereq: Modbench-2, Modbench-3 (winner map). Effort: ~2 wk (grew from ~1 wk — absorbs the `GameDirectory` resolver below, Wine-path normalization, and load-order deployment).

`fs.link`/`fs.symlink` are native to Node — no P/Invoke, no platform-specific VFS code.

## Scope note — `GameDirectory` absorbed from Modbench-2

The spec assigns `GameDirectory` (config + `GamePathDetector` fallback + stock-folder setup) to Modbench-2. It was deferred out of 2.1 and never resurrected in Modbench-3 (`vanillaMasters.ts` reads MO2's own `gamePath` directly instead — see the comment at the top of that file). Deploy cannot pick a hardlink target without resolving a real directory, so this gap now blocks Modbench-4 and closes here.

**Majority use case**: a *stock game folder* kept local to the modlist (same volume as `mods/` by construction), not the Steam library on a possibly different drive. The resolver and the same-volume UX below are written with that as the common path, not the fallback.

**Scope decision (confirmed with user):** this task adds the ability to *point* `mEdit.mods.gameDirectory` at a stock folder the user already prepared — it does **not** build an in-app "copy the whole game tree" wizard (progress UI, disk-space checks, resume). That's a larger follow-up if wanted. When resolution fails, mEdit suggests the Wabbajack convention `<instanceRoot>/Stock Game Folder/` (sibling to `mods/`) as prompt text only — it doesn't create anything there. (`<instanceRoot>` = the open VS Code workspace root, per `medit-vscode/CLAUDE.md`: the workspace root *is* the MO2 instance dir.)

## Extension

### 1. `GameDirectory` resolver (`modmanager/gameDirectory.ts`)

New settings (`package.json`, live in the instance's workspace settings, not user/global — each modlist instance has its own game directory):

- `mEdit.mods.gameDirectory` (string, default `""`) — explicit root: the folder containing the game executable and `Data/`. Steam install *or* stock folder — identical code path either way.
- `mEdit.mods.deploymentMode` (enum `"standalone" | "external"`, default `"standalone"`) — `"external"` means MO2/Vortex owns deployment; hides Deploy/Purge/Launch Game.
- `mEdit.mods.launchCommand` (string, default `""`) — optional override for Launch Game, template with a `${executable}` placeholder. Escape hatch for Proton/Wine (Linux stock folders can't always be spawned directly — see Open Questions). Empty = spawn `${executable}` directly.

`resolveGameDirectory(instanceRoot, config, detectPaths)` resolution order, first hit wins:

1. `mEdit.mods.gameDirectory`, if set — validate `Data/` exists under it, error (ADR-0026 "explicit action failed") if not.
2. MO2's own `ModOrganizer.ini` `gamePath` (existing `readGamePath` from `mo2/modOrganizerIni.ts`) — most working instances already point this at their real game dir, frequently already a stock folder (Wabbajack-style setups). **Must normalize a Wine/Windows path first** (see below).
3. `GamePathDetector.detectGamePaths()` (Steam autodetect) — root = `dirname(dataFolder)`.
4. Prompt (quick pick / input box, mirroring `SessionWizard`'s pattern): "point at your stock folder or Steam install," suggesting `<instanceRoot>/Stock Game Folder/` as example text (the Wabbajack convention). Persist the answer to `mEdit.mods.gameDirectory` in workspace settings so it isn't re-asked.

Returns `{ root: string; dataFolder: string }`.

**Wine/Windows path normalization (required, not optional).** On Linux, `ModOrganizer.ini`'s `gamePath` is a Wine drive-mapped, backslash path — the real LitR install has `gamePath=@ByteArray(Z:\home\wayne\Games\FO4\LitR\Stock Game Folder)`. `readGamePath` returns that string verbatim. `join('Z:\\home\\...', 'Data')` is not a valid POSIX path, so `Data/` validation fails and step 2 silently falls through to Steam autodetect (which points at the *untouched Steam install, not the stock folder*). This is already an unnoticed bug in `vanillaMasters.ts` today (its `try/catch` degrades to an empty vanilla-master set). `resolveGameDirectory` must strip a leading `X:` drive letter and convert `\`→`/` before validating `Data/`. Cover with a dedicated test slice.

**Follow-up cleanup**: once this lands, change `readVanillaMasters` to accept the resolved `GameDirectory` instead of re-deriving it from `ModOrganizer.ini` itself — removes the now-stale "deferred" comment, the second divergent game-path lookup, *and* the silent Wine-path failure above (one normalization point fixes both consumers).

### 2. `Deployer.deploy` (`modmanager/deployer.ts`)

`deploy(instanceRoot, gameDirectory, index: FileConflictIndex, reporter, statFn = fs.stat)`:

The winner map is the existing `FileConflictIndex` (`fileConflictIndex.ts`) from Modbench-3 — reuse it, do **not** introduce a `winnerIndex` type. Its `files` is a `Map<relativePath, ConflictEntry>` where the **map key is the `Data/`-relative target path** and `entry.winner` is the **absolute hardlink source**. So iterate `index.files` as `[relativePath, entry]`: source = `entry.winner`, target = `join(gameDirectory.dataFolder, relativePath)`. (There is no `entry.relativePath` field — the path is the key.)

1. Same-volume check: `statFn(mods/).dev === statFn(gameDirectory.root).dev`. `statFn` is injectable so the violation path can be unit-tested with a fake returning different `dev` numbers — a real second volume isn't guaranteed to exist on a dev machine or CI runner. On mismatch, do **not** hardlink — report (ADR-0026 "explicit action failed") offering (a) point `mEdit.mods.gameDirectory` at a same-volume stock folder, or (b) fall back to `fs.symlink` for this deploy (warn: Windows needs admin/Developer Mode).
2. On first deploy (no existing manifest): snapshot the current `Data/` file list as `preExisting` *before* creating any links — this is the vanilla baseline `purge` diffs against later, and is what makes the manifest crash-recovery-safe (self-contained, no reconstruction needed after an interrupted run).
3. For each winner entry: **skip any whose relative path's first segment is `root/`** (MO2 Root-Builder convention — those files map to the *game root*, not `Data/`; deferred, see Open Questions). Otherwise, if `Data/<relativePath>` exists and is **not** listed in the *previous* manifest's `links` → skip and report (ADR-0026 integrity tier — this mod's file silently failing to apply must never be silent). Otherwise (path is free, or was our own prior link) → remove any stale link, then `fs.link` (or `fs.symlink` if the volume fallback was chosen).
4. **Deploy load order.** Copy the active profile's `plugins.txt` (and `loadorder.txt`) to the location the game reads them so deployed plugins actually *load*, not just appear. Resolve that target from the existing `mEdit.game.pluginsTxtPath` setting / `GamePathDetector`'s `pluginsTxt` — do not hardcode it (under Proton the game reads from the prefix's `.../compatdata/377160/pfx/.../AppData/Local/Fallout4/plugins.txt`). Record the deployed load-order file path in the manifest so `purge` can back it out.
5. Write `mods/.medit-manifest.json`: `{ links: string[]; preExisting: string[]; loadOrder?: string[] }` (relative link paths + absolute load-order target paths), replacing any previous manifest.

A crash mid-deploy leaves a manifest that undercounts `links`; the next deploy re-walks all winners and fills in the rest — self-healing on retry, no special recovery code needed.

### 3. `Deployer.purge`

`purge(instanceRoot, gameDirectory, reporter)`:

1. Read `.medit-manifest.json`; no-op if absent.
2. Delete each `links` entry from `Data/` (tolerate `ENOENT` — already gone). Remove the deployed `loadOrder` file(s) recorded in the manifest.
3. Walk `Data/`; any file present that is in neither `links` nor `preExisting` → move to `<instanceRoot>/overwrite/<relativePath>` (F4SE outputs, MCM INI writes), creating parent dirs as needed. **`overwrite/` is a sibling of `mods/`, NOT `mods/overwrite/`** — the real MO2 layout keeps it at the instance root; writing `mods/overwrite/` would create a phantom mod MO2 treats as installed.
4. Prune directories under `Data/` left empty by removing our links (leave any dir that still holds `preExisting`/foreign files).
5. Delete the manifest.

### 4. Mod List header wiring

- `mEdit.modList.deploy` / `mEdit.modList.purge` commands + icon buttons, `navigation` group after the existing buttons (`navigation@5`/`@6`).
- Gated on a `medit.deploymentStandalone` context key (casing matches the existing `medit.viewMode` `setContext` at `extension.ts:108`), set from `mEdit.mods.deploymentMode` on activation and refreshed on config change. Note: there is **no existing `onDidChangeConfiguration` listener** in `extension.ts` — this is a net-new subscription, not an extension of a current one.

**`deploymentMode` default rationale.** Defaults to `standalone` for every instance, including live MO2/Wabbajack ones — deliberate: MO2's USVFS deployment is **Windows-only**, so on Linux the hardlink deployer *is* the deployment mechanism and `standalone` is correct. `"external"` (MO2/Vortex owns deployment, hides Deploy/Purge/Launch) is meaningful mainly on Windows, where running both would collide. Keep it a manual setting; do not auto-deploy in `external` mode.

### 5. "Launch Game" command (`mEdit.modList.launchGame`)

Deploy → switch sidebar to Plugin List (reuse the existing `medit.viewMode` toggle, same as `mEdit.modList.launchMedit`) → spawn the executable from `gameDirectory.root` (via `mEdit.mods.launchCommand` template if set, else `child_process.spawn` directly) → purge on process exit.

Executable filename resolution follows the existing `GamePathDetector` precedent of a small hardcoded per-game constant (`Fallout4.exe`) rather than a new backend lookup — consistent with "tests may use FO4 as concrete game," extended the same way `GamePathDetector` will be when multi-game support lands.

**F4SE limitation (consequence of deferring `root/`).** Because `root/` files (e.g. `f4se_loader.exe`) are not deployed (§2 step 3), the default `Fallout4.exe` launch target won't load F4SE-dependent mods. Users who need F4SE set `mEdit.mods.launchCommand` to point at an already-present loader (e.g. a `f4se_loader.exe` the stock folder ships). This overlaps with the Linux/Proton escape hatch below — the same override serves both.

## Test infrastructure (build before the first `deploy` slice)

The committed fixtures `conflict-instance`/`mo2-instance` are static read-only trees, and `buildTes4Buffer.ts` only builds an in-memory `Buffer`. But the `mkdtemp` + `afterEach(rm)` idiom for mutating a real scratch tree **already exists** in the modmanager tests — `vanillaMasters.test.ts:10-12` and `mo2/Mo2ModlistSource.test.ts:65-71`. **Reuse that idiom**; the only genuinely new requirement is the sibling layout:

- New `modmanager/test/deployerFixture.ts`: `fs.mkdtemp`s a scratch root and creates `mods/<Mod>/<relativePath>` files and an empty `Data/` dir **as siblings inside that one root** — never split across `os.tmpdir()` and the repo checkout, which risks a spurious same-volume failure if `/tmp` is a separate mount from the workspace in CI. (This single-root-siblings constraint is the new part; existing tests `mkdtemp` freely into `os.tmpdir()`, which is fine for them but would break the `dev` check here.) Returns the paths.
- Every test using it registers `afterEach(() => fs.rm(root, { recursive: true, force: true }))` — copy the shape from the two tests above; it runs even on assertion failure, so a failing test can't leak temp dirs.
- The same-volume-*violation* test does not use this fixture's real paths for the check itself — it calls `deploy` with a fake `statFn` returning different `dev` values, per the injectable-`statFn` note above.

## Tests

Sequenced as tracer-bullet slices — one RED/GREEN cycle per bullet, in this order, not written as a batch:

1. [ ] Unit: `resolveGameDirectory` resolves an explicit `mEdit.mods.gameDirectory` setting directly.
2. [ ] Unit: `resolveGameDirectory` errors (not silently falls through) when that explicit setting has no `Data/` subfolder.
3. [ ] Unit: `resolveGameDirectory` falls back to MO2 ini `gamePath` when unset.
4. [ ] Unit: `resolveGameDirectory` normalizes a Wine `gamePath` (`Z:\home\...\Stock Game Folder`) to its POSIX path and validates `Data/` — the real-LitR case; without this, Linux falls through to Steam autodetect.
5. [ ] Unit: `resolveGameDirectory` falls back to `GamePathDetector` autodetect when both are unset.
6. [ ] Unit/integration (via `deployerFixture`): `deploy` on an empty `Data/` creates a hardlink for one winner and writes a manifest with `links` + a `preExisting` snapshot.
7. [ ] Unit/integration: `deploy` skips a winner whose relative path starts with `root/` — it is NOT linked into `Data/root/`.
8. [ ] Unit/integration: `deploy` copies the active profile's load-order file to the resolved target and records it in the manifest; `purge` removes it.
9. [ ] Unit/integration: `deploy` skips and *reports* (not silently drops) a winner whose `Data/<path>` already exists and isn't in a prior manifest.
10. [ ] Unit/integration: re-running `deploy` after a winner changes (reorder) relinks only the changed path; untouched winners are left alone.
11. [ ] Unit/integration: `purge` deletes manifested links only, leaving `preExisting` files untouched.
12. [ ] Unit/integration: `purge` moves a stray `Data/` file (in neither `links` nor `preExisting`) into `<instanceRoot>/overwrite/` (sibling of `mods/`, not `mods/overwrite/`).
13. [ ] Unit: same-volume violation (fake `statFn`) blocks hardlinking and surfaces the fallback choice instead of silently symlinking.
14. [ ] Integration: Deploy/Purge/Launch Game commands are registered and their header buttons hidden when `mEdit.mods.deploymentMode` is `"external"`.

## Open questions

- **Overwrite-folder UX** (reassign/discard surface for `<instanceRoot>/overwrite/`) — see spec "Open Questions"; not built here, just the collection step.
- **MO2 Root-Builder (`root/`) folder** — deferred (confirmed with user). Mods with a `root/` subfolder (e.g. `mods/F4SE/root/f4se_loader.exe`) map to the *game root*, not `Data/`. `deploy` excludes them (§2 step 3) rather than mis-linking into `Data/root/`. Consequence: F4SE isn't auto-deployed — see the Launch Game limitation. Full root-folder support is a follow-up.
- **Linux/Proton launch** — spawning a stock folder's `.exe` directly doesn't work unwrapped under Proton/Wine. Scoped here as an escape hatch only (`mEdit.mods.launchCommand` override); no bundled Proton/Wine invocation logic. Revisit if this proves too rough in practice.
- **Load-order target under Proton** — the game reads `plugins.txt`/`loadorder.txt` from the Proton prefix's AppData (`.../compatdata/377160/pfx/drive_c/users/steamuser/AppData/Local/Fallout4/`), not a fixed path. Deploy resolves the target from `mEdit.game.pluginsTxtPath` / `GamePathDetector`; if autodetection proves unreliable across Proton prefixes, the setting is the escape hatch.
- **Automated stock-folder copy wizard** — explicitly deferred (see Scope note above); `mEdit.mods.gameDirectory` only points at a folder the user prepared externally.

## Proof

Implemented via the 14 tracer-bullet slices (each RED→GREEN) plus a self-review pass that
caught and fixed two lifecycle bugs (stale prior links on re-deploy after a mod is disabled;
a failing load-order copy orphaning the manifest) — both TDD'd. New unit tests:
`gameDirectory.test.ts` (5), `deployer.test.ts` (10, via `test/deployerFixture.ts`),
`vanillaMasters.test.ts` (+1 Wine-path case). `resolveGameDirectory`'s Wine normalization
also fixed the pre-existing silent-empty-masters bug in `vanillaMasters.ts` on Linux.

Deferred as agreed: `root/` (F4SE) deployment excluded from deploy (documented limitation);
automated stock-folder copy wizard.

```text
npm run test:unit         → all suites green (incl. gameDirectory 5, deployer 10)
npm run test:integration  → 4 passing; mEdit.modList.{deploy,purge,launchGame} in EXPECTED_COMMANDS
npm run build             → clean; eslint clean
```

Commit: see the modbench-4 merge commit.
