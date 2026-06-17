---
status: superseded by ADR-0022
---

# Backend is always user-launched; the extension only connects

> **Superseded by [ADR-0022](./0022-extension-owns-backend-lifecycle.md).** The mod-manager work makes mEdit reconstruct MO2's view from physical paths rather than running inside its VFS, so the extension now owns the backend lifecycle. Retained for history.

The VS Code extension and the C# backend service are started independently by the user. The extension never spawns the backend — on activation it polls `GET /health` until the backend is up, then emits `attached`. If no backend is found, the status bar says so and the user starts it manually.

**Why this matters for MO2:** Mod Organizer 2 uses a Virtual File System (usvfs) that makes mod files appear in the game's Data folder only for processes it launches. If the extension spawned the backend automatically, the VFS would not be active and MO2's mods would be invisible. The always-separate model gives MO2 users the standard xEdit workflow: add the backend to MO2's Tools list, start it from MO2 (VFS activates), open VS Code — the extension finds the running backend and connects.

**Path resolution:** The game folder is the canonical anchor, not any mod manager's internal data. All mod managers ultimately surface plugins at the paths the game reads. MO2 on Linux (no VFS, physical paths) is deferred post-v1 and will require a `POST /session/load-explicit` endpoint accepting `[{name, physicalPath}]` pairs.

## Considered options

**Extension spawns backend** — Breaks MO2 VFS compatibility because MO2 cannot inject its VFS into a process the extension spawned independently. Rejected.

**Connection-first with managed fallback** — Extension checks for a running backend and spawns if none found. Excluded: the spawn path is a footgun for MO2 users who forget to launch via MO2 (the extension silently spawns a VFS-less process). Explicit separation makes the correct workflow unambiguous.

**MO2 IPC** — MO2 exposes limited IPC. Complex, version-dependent, and undocumented. Rejected.
