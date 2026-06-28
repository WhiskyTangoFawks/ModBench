# Modbench-5 — Editing integration & backend lifecycle (was M-4)

**Status: Not Started**
**Recommended model: Opus 4.8** — process lifecycle (spawn/warm/teardown/crash-restart) crossing extension and backend, reversing an existing rule; the kind of stateful integration where subtle ordering bugs hide.

*Goal: unify the mod manager with the record editor — wire the active modlist into a `load-explicit` session and have the extension own the backend's lifecycle.*

Spec: [mod-manager.md](../mod-manager.md) ("Backend lifecycle", "View Switching"). Prereq: Modbench-1 (`load-explicit` proven), Modbench-2 (modlist source). Architecture: [ADR-0022](../adr/0022-extension-owns-backend-lifecycle.md), [ADR-0015](../adr/0015-single-session.md). Effort: ~1 wk.

This reverses the "never spawns backend process" rule in `medit-vscode/CLAUDE.md` ([ADR-0022](../adr/0022-extension-owns-backend-lifecycle.md)). The `load-explicit` source itself was de-risked in Modbench-1; this productionises it.

## Extension

- [ ] `BackendManager` gains spawn/teardown (it previously only health-polled):
  - **Spawn** lazily on first entry into Plugin (editing) mode for the active modlist.
  - **Warm** across Mod List ⇄ Plugin List toggles for the lifetime of that profile's modlist (one backend, one session — [ADR-0015](../adr/0015-single-session.md)) to avoid re-indexing churn.
  - **Teardown** on switching profile/modlist, closing the workspace, or explicit close (the "Close mEdit" button in the mEdit view header — see [UI_SPEC](../../medit-vscode/src/modmanager/docs/UI_SPEC.md) §8); restart on crash.
- [ ] Build the `load-explicit` ordered `{name, physicalPath}` list from the active modlist's enabled plugins + vanilla masters and hand it to the backend session.
- [ ] Mod List ⇄ Plugin List header toggle (both views registered, one visible via `when` clause); entering Plugin List triggers the lazy spawn. "Launch mEdit" in Loadout header + "Close mEdit" in mEdit header both wire here.

## Backend

- [ ] Promote the Modbench-1 spike `load-explicit` source to the supported session source (no separate spike list).

## Tests

- [ ] Integration: entering Plugin mode spawns the backend and loads the active modlist as a session; toggling back to Mod List keeps it warm.
- [ ] Integration: switching profile tears down and rebuilds the session.

## Proof

*To be filled in on completion. Paste `dotnet test` + `test:integration` output and commit hash here.*
