---
status: accepted
---

# Plugin identity is (origin, filename), not filename

Amends [ADR-0006](0006-one-row-per-formkey-plugin.md).

## Context

ADR-0006 makes `(form_key, plugin)` the composite primary key of every record table, where `plugin`
is the bare filename. That holds only while exactly one physical file can ever answer to a given
filename in a load order.

Three things break that assumption at once:

- **Shadowed copies.** When two mods ship `Foo.esp`, MO2 priority picks one and the other is
  discarded before the load order is built. `FileConflictIndex.filesByMod` already knows about both;
  loading them together collides on the key.
- **Drift.** Once mod content is reflected live
  ([ADR-0035](0035-one-plugins-tree-editing-is-a-capability.md)), installing, uninstalling or
  reprioritising a mod can change *which file* a filename resolves to while the old one is still
  indexed. "Which version do I have loaded" stops being a question only sideloading asks.
- **Non-participating files generally.** ADR-0035 indexes files that `plugins.txt` does not name.
  A filename is not a unique handle for them by construction.

## Decision

**A plugin is identified by `(origin, filename)`.** `origin` is the mod folder that provides the
file, with reserved values for the game's `Data/` directory and MO2's `overwrite/`. Record tables
key on `(form_key, origin, plugin)`; ADR-0006's query shapes are otherwise unchanged.

**The column is named `origin`, not `mod`.** The Editing context knows a plugin has an origin and
treats it as an opaque string it never interprets; Mod Management knows that origin is a mod folder
and is the only side that renders it. This keeps the vocabulary boundary
(`CONTEXT-MAP.md`) intact while the boundary object sits in a primary key — the alternative,
putting "mod" in the Editing index's key, is the strongest possible violation of it.

**Origin is never what the user reads.** The tree shows the filename; the origin is in the tooltip.
It appears inline only when two loaded copies share a filename, and in the compare grid the same
rule applies to column headers — filename in the header, origin in its tooltip, inline only on
collision. Column headers are the scarcest space in the grid and xEdit's carry filenames alone.

**A path is not the identity.** `(origin, filename)` is stable, readable, survives the instance
being relocated, and is exactly what the tooltip already needs to show. An absolute path is none of
those things and would leak the user's filesystem into every wire message.

## Consequences

- **This is a wide refactor.** `plugin` is not merely a column: it is the identity threaded through
  every override, field, placement and reference query, through the backend wire protocol, and
  through the record editor's webview state — focused cell, collapsed columns, remove-override,
  add-master, copy-as-override, every array and VMAD operation, every edit. Two columns that look
  alike are indistinguishable to all of them, so the display change and the key change must land
  together or the grid silently mis-targets.
- The open question "plugin identity scheme when the same filename appears N times" is answered
  here.
- Shadowed copies are **read-only**, reusing the existing immutable-plugin treatment. An edit to a
  file the game does not load produces no observable change anywhere — no winner moves, no badge
  moves, nothing happens in-game — which is a footgun that only reveals itself later. The escape
  hatch is better than the feature: raise that mod's priority and it becomes the winning copy and
  editable in one gesture. Editability can be added later by unhiding the actions if the need
  proves real.
- Vanilla, DLC and Creation Club plugins take the reserved `Data/` origin rather than a null
  component in a primary key.
