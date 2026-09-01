---
status: accepted
---

# The load order is mirrored, not loaded: one reconcile verb, every copy registered, no session

Governs [ADR-0035](0035-one-plugins-tree-editing-is-a-capability.md) § The
loading model and § Live mutation, [ADR-0001](0001-persistent-per-instance-index-load-order-is-a-registration.md)
points 2 and 4, and the Mod Management → Editing relationship in [CONTEXT-MAP.md](../../CONTEXT-MAP.md).

## Context

The interface between Mod Management and Editing was modelled on MO2 and xEdit, which are separate
programs: MO2 deploys a virtual `Data/`, xEdit reads it, so xEdit needs a **session** — pick the
plugins, load them, work, exit. That model leaked into Modbench as `POST /session/load-explicit`
(tear the session down, rebuild it from a flat list), and every later loadout gesture was bolted on
as a patch to it: `/plugins/reread` for a mod-order change (`pluginDrift.ts`),
`/plugins/{p}/participation` for an enable/disable, `/plugins/load`/`unload` for a copy the load
order does not point at, and — the largest event — a plugins.txt reorder still fell back to the
full reload.

Modbench is not two programs. Mods are installed, reordered, enabled and disabled while the editor
is open, and the editor must follow. ADR-0001 made the index a persistent mirror of
the plugin *files* that validates itself against disk; the load order was the one input the index
still received as a command rather than as state. There was no moment at which Editing could ask
"is my load order still true?" — it could only be told, and only in whole.

## Decision

1. **The boundary object is the Plugin load order, sent as state.** Mod Management sends one
   idempotent snapshot — `PUT /load-order` — whenever anything that feeds it changes: activation,
   profile switch, a `modlist.txt` or `plugins.txt` write, an install or uninstall. Editing
   **reconciles** the snapshot against what it holds: register what is new (indexing only what the
   mirror has never seen — ADR-0001), unregister what is gone, update slot and flags on what
   moved, then one winner sweep, one conflict invalidation, one mirror-watch reconcile. Nothing is
   torn down; a snapshot identical to the current state is a no-op. `load-explicit`, `reread`,
   `participation`, `load` and `unload` are retired.

2. **Every physical plugin copy in the instance is in the snapshot and is registered.** Not only
   the copies the load order points at: a copy losing the Mod override order, and a file no
   `plugins.txt` line names, are registered like any other. A registration row is one physical
   copy — `(name, origin)` (ADR-0036) — and carries three facts Mod Management already computes
   and used to discard at the boundary:

   | fact | source |
   |---|---|
   | `load_order_idx` | the name's `plugins.txt` slot; null when no line names it |
   | `enabled` | the line's `*` prefix |
   | `winning` | this copy is the one the Mod override order resolves the name to |

   **Participation is derived, never stored:** `enabled AND winning AND load_order_idx IS NOT NULL`.
   Only participating rows compete for winner or count in a conflict. "Overridden" and "disabled"
   are thereby the same mechanism — a registered row that does not participate — which is what
   makes inspecting a losing copy free: it is already there.

   This rewrites ADR-0035's hidden-means-absent invariant a second time (ADR-0001 had already
   made it "absent means unregistered"). It is now: **a non-participating row never influences
   winners or conflicts and is hidden by default; it is visible on request, beside the
   participating rows, marked with the reason it does not participate.** The intent that the
   invariant guarded — `is_winner` must describe the load order the game actually has — is
   carried entirely by the participation predicate.

3. **There is no session.** Session management is profile management, and the profile is MO2's.
   Editing holds *the load order* and *the index*; both are mirrors kept true by observation and
   by reconcile. Nothing is loaded, reloaded or exited: a plugin that fails to parse is a row in an
   error state, the way a file with a diagnostic is still a file. `SessionManager`, `GameSession`,
   `modbench.reloadSession`, "session settled", "exit to Loadout on load failure" and the
   `/session/*` route prefix go with the concept. Opening the index file does not clear the
   registration table (ADR-0001 point 4): the rows are the last known load order, and the
   first reconcile corrects them.

## What does not change

- Mod Management still owns resolution of both override orders and still never calls the backend
  with anything but plugin files at physical paths (ADR-0036, ADR-0041). The tuple that crosses
  gains two booleans that are already shared vocabulary (winning/losing — CONTEXT-MAP.md); no
  "mod", no modlist, no profile crosses.
- The mirror (ADR-0001) is untouched. Reconcile is cheap precisely because registration and
  indexing were already separated; this decision removes the last bulk verb on top of them.
- Progressive indexing and its "conflict information not yet computed" state stay; they now
  describe a reconcile in progress rather than a load.

## Consequences

- Cold-index cost is bounded by every plugin file the snapshot names, not by the load order —
  paid once per copy, ever, by the mirror. The snapshot is what Mod Management already walks for
  its own file-conflict index: every root-level plugin in every **enabled** mod, `overwrite/`, and
  the game's `Data/` copy of every listed name no mod provides. A disabled mod's plugins are not in
  it — MO2 does not deploy them, and Mod Management does not walk them — so enabling a mod that
  ships plugins is the moment its copies first arrive and pay their one index. Widening the walk to
  disabled mods is a Mod Management change if ever wanted, not a boundary change.
- Two registered copies can share a filename (a winning copy and a losing copy). Editing keys
  them by `(origin, name)`; the losing copy is not displayed today — whether and how it surfaces
  is an open UX design, and showing its origin will be a display obligation when it does.
- Editing still cannot verify the load order against the profile files on its own after a
  restart; it trusts the next snapshot, and the extension sends one on activation. Whether Editing
  should read the profile itself — which would move Mod override order resolution across the
  context boundary — is deliberately left open.
- Live reorder, mirror watches for plugins registered mid-session, and
  `pluginDrift.ts` all fold into the reconcile verb rather than being fixed separately.

## Alternatives rejected

- **Keep `load-explicit` and add a reorder verb** — a fifth patch on a bulk verb; every future
  loadout gesture would need its own endpoint and its own drift story.
- **Editing reads `modlist.txt`/`plugins.txt` itself** — makes the registration self-validating
  like the mirror, but puts Mod override order resolution (and "mod") inside Editing. Deferred, not
  refused.
- **Register only participating copies, load losers on demand** (ADR-0035's original answer) —
  keeps a second loading path and a second identity story (`unlistedPlugins.ts`, `/plugins/load`)
  for something that is, to the user, the same gesture as a disabled plugin.
