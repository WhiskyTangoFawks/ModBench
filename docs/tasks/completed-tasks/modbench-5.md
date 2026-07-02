# Modbench-5 — Editing integration & backend lifecycle (was M-4)

**Status: Complete**
**Recommended model: Opus 4.8** — process lifecycle (spawn/warm/teardown/crash-restart) crossing extension and backend, reversing an existing rule; the kind of stateful integration where subtle ordering bugs hide.

*Goal: unify the mod manager with the record editor — wire the active modlist into a `load-explicit` session and have the extension own the backend's lifecycle.*

Spec: [mod-manager.md](../mod-manager.md) ("Backend lifecycle", "View Switching"). Prereq: Modbench-1 (`load-explicit` proven), Modbench-2 (modlist source). Architecture: [ADR-0022](../adr/0022-extension-owns-backend-lifecycle.md), [ADR-0015](../adr/0015-single-session.md). Effort: ~1 wk.

This reverses the "never spawns backend process" rule in `medit-vscode/CLAUDE.md` ([ADR-0022](../adr/0022-extension-owns-backend-lifecycle.md)). The `load-explicit` source itself was de-risked in Modbench-1; this productionises it.

## Extension

- [x] `BackendManager` gains spawn/teardown (it previously only health-polled):
  - **Spawn** lazily on first entry into Plugin (editing) mode for the active modlist (`start()`; attaches to an already-healthy backend instead of double-spawning — preserves the dev/attach workflow).
  - **Warm**: the session persists for the lifetime of an editing session. **Decision (confirmed with user): Close always tears down** — see *Deviations* below; the "warm across every toggle" variant was not built.
  - **Teardown** (`stop()`) on switching profile/modlist, closing the workspace (`dispose`), or explicit close (the "Close mEdit" button in the mEdit view header — see [UI_SPEC](../../medit-vscode/src/modmanager/docs/UI_SPEC.md) §8); **restart on crash** (`'restarted'` event → reload session).
- [x] Build the `load-explicit` ordered `{name, path}` list from the active modlist's enabled plugins + vanilla-master fallback (`modmanager/explicitSession.ts` `buildExplicitPlugins`) and hand it to the backend session (`SessionController.loadExplicitSession`). Vanilla masters are prepended by the backend from the resolved **Data folder** (`gameDirectory`), not listed explicitly.
- [x] Mod List ⇄ Plugin List header toggle (both views registered, one visible via `when` clause); entering Plugin List triggers the lazy spawn. "Launch mEdit" in Loadout header (real handler) + new "Close mEdit" (`mEdit.closeMedit`) in mEdit header both wire the `medit.viewMode` context + lifecycle.

## Backend

- [x] `load-explicit` was **already a first-class supported source** (built in Modbench-1: `POST /session/load-explicit`, `ISessionManager.LoadExplicit`, `GameSession.LoadExplicit`, `SessionLoadExplicitRequest`/`ExplicitPlugin`). No spike endpoint/flag/list existed in the code — "promotion" was making production wire it. No backend code change; 758 tests still green.

## Tests

- [x] Integration: `mEdit.closeMedit` registered; command-registration suite green. (View-mode context transitions aren't observable via the VS Code API — verified by manual test, not integration assertion.)
- [x] Integration: switching profile calls `backendManager.stop()` (teardown) before rebuilding — wired in `mEdit.modList.switchProfile`.
- Unit: `buildExplicitPlugins` order/winner/fallback (2) + `readEnabledPlugins` enabled-only (1) + `SessionController.loadExplicitSession` POST/failure/zero-plugins (4) + `BackendManager` spawn/attach/cancel/re-entrancy/crash-cap/stop (10).

## Deviations from the original plan

- **Warm-across-toggles dropped (user decision).** Close always tears down and re-entering editing re-spawns + re-indexes. The "toggling back to Mod List keeps it warm" integration bullet is therefore replaced by the Close-tears-down wiring. UI_SPEC §8 already matched ("Close … tears down the backend session"); the mod-manager.md "Warm" bullet was reworded to match.
- **Session source: always `load-explicit` from the active modlist (user decision).** The old auto-connect + auto-wizard-on-attach at activation was removed (dead `SessionController.onBackendConnected` + its tests deleted), and post-review the entire legacy single-data-folder wizard path (`SessionWizard`, `loadSession`, `mEdit.loadSession`) was deleted too — see Open Questions.
- **Spawn mechanism: bundled self-contained binary (user decision).** New `build:backend` script (`dotnet publish --self-contained -r linux-x64 -o backend`), chained into `vscode:prepublish`; `.vscodeignore` added so the `.vsix` ships `out/` + `backend/` but not sources. Cross-platform `.vsix` (per-RID / download-on-first-run) is a follow-up — see Open Questions.

## Open questions (follow-ups)

- **Cross-platform packaging.** `build:backend` publishes the host RID only (`linux-x64`). Tracked as tech debt: [tech-debt/cross-platform-backend-publish.md](../tech-debt/cross-platform-backend-publish.md).
- The `/manual-test` skill's "session wizard auto-fires on attach" note is now stale; the new flow enters editing via **Launch mEdit** (attach path still works if a dev backend is already running).
- **Legacy `mEdit.loadSession` + `SessionWizard` removed** (post-review, confirmed with user): the single-data-folder wizard path no longer self-started a backend after activation stopped auto-connecting, and the mod-manager flow supersedes it. Deleted `SessionWizard.ts`/its tests, `SessionController.loadSession`, the `makeWizard` dep, and the `mEdit.loadSession` command.

## Proof

Implemented via TDD tracer-bullet slices (each RED→GREEN). No backend code change; the
Modbench-1 `load-explicit` endpoint was already supported. Verified the bundled
self-contained backend launches on the extension-supplied `--urls` port (5199, overriding
the hardcoded `appsettings.json` 5172) and serves `/health` 200 with no CLI session args —
the exact spawn contract `BackendManager.start()` depends on.

A `/simplify` + high-effort `/code-review` pass followed. Simplify extracted the shared
`reportSkippedPlugins` (`sessionFailures.ts`) and `meditConfig`/`makeDetectPaths` helpers.
Code-review surfaced (and this pass fixed, TDD) real `BackendManager` lifecycle defects:
`start()` re-entrancy (concurrent calls / a restart racing a manual launch → double-spawn)
and `stop()` not cancelling an in-flight `connect()` poll (a late `200` resurrecting a
just-closed session) — both solved with an in-flight `startPromise` + a `generation` token —
plus a crash-restart cap, an `enterEditing` failure path that now tears down the half-started
backend and resets the view, and the restored "0 enabled plugins" ADR-0026 warning.

New/changed files: `modmanager/explicitSession.ts` (+ test), `Mo2ModlistSource.readEnabledPlugins`,
`SessionController.loadExplicitSession`, `sessionFailures.ts`, `BackendManager` lifecycle,
`extension.ts` launch/close/lifecycle wiring, `package.json` (`mEdit.closeMedit` + `build:backend`),
`.vscodeignore`, `CLAUDE.md`/`mod-manager.md` doc updates.

```text
npm run test:unit         → 393 passed (incl. explicitSession, readEnabledPlugins,
                            loadExplicitSession ×4, BackendManager spawn/cancel/cap/crash ×10;
                            legacy SessionWizard/loadSession tests removed)
npm run test:integration  → 4 passing; mEdit.closeMedit in EXPECTED_COMMANDS
npm run build             → clean; npm run lint → clean
npm run build:backend     → self-contained MEditService.Api published to backend/;
                            manual launch on :5199 → /health 200
dotnet test -v minimal    → 758 passed, 0 failed (backend unchanged)
```

Commit: see the modbench-5 merge commit.
