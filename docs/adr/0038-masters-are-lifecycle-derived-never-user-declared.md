---
status: accepted
---

# Masters are lifecycle-derived from content, never user-declared

A permitted divergence from [ADR-0034](0034-xedit-is-the-ux-reference-for-the-record-editor.md).

## Context

xEdit exposes masters management as three direct user actions on a plugin's file node: Add Masters,
Sort Masters, Clean Masters. #86 built the first slice of this for mEdit — a validated, add-only
`masters` field on the header record, edited like any other pending change, plus an automatic
add-master step so a staged copy never leaves its target referencing an undeclared origin (invariant
B). #87 deferred Sort/Clean/Remove to future Python scripts, on the assumption they were expensive,
whole-plugin operations in the same risk class as FormID renumbering — matching xEdit, which patches
stored FormID bytes in place, so reordering or removing a master requires walking and rewriting
every reference in the file to keep each one pointing at the right master.

Design review (#283) surfaced a real use for a manually-declared, content-free master: adding an
otherwise-unused plugin as a master purely to pin load order (forcing the game to load it first,
with nothing in the plugin's own content actually referencing it). This is a real modding pattern,
but it's a load-order concern — Mod Management's job — expressed invisibly inside an Editing-context
object, per-plugin, unauditable from the surface that's actually supposed to own ordering
(`plugins.txt`/load-order rules), and it silently breaks whenever the referenced plugin updates.

Separately, this codebase's write pipeline doesn't share xEdit's risk profile. Mutagen rebuilds a
plugin's outgoing master list from its live object graph on every save rather than patching stored
bytes, and re-derives every FormID's local master-index from that same fresh list at write time.
There is no "declared masters drifted out of sync with what's on disk" failure mode here the way
there is in a byte-patching editor — sort and clean are already the pipeline's default,
unconditional save-time behavior, not separate expensive operations.

## Decision

**A plugin's masters are wholly derived from its content, never directly user-editable.** Nothing —
not a native command, not a script — declares a master ahead of the content that requires it, and
nothing removes, reorders, or bulk-cleans a master directly. `masters` is read-only: visible on the
header record, computed as Effective masters (committed masters unioned with the origin plugins
everything the plugin's content, committed and pending, actually references). Saving a plugin always
writes exactly that set.

This makes Add, Sort, and Clean disappear as distinct operations rather than gain a UI. Add is
invariant B, unconditional and automatic on any staged edit that requires it. Sort and Clean are
inherent to every save — not staged, not visible as a pending change, not scriptable as a separate
primitive.

## Consequences

- The manual "Add Master…" command, its picker, and the append-only validation that constrained it
  are removed — there is no direct edit path for `masters` left to validate.
- A modder who wants to force one plugin to load after another with no real content dependency
  between them has no supported way to do it from mEdit — that has to be expressed in Mod
  Management's own load-order surface instead of by hand-declaring a master.
- #87's scope narrows: sort/clean/remove-masters is removed from it, since nothing needs a scripted
  path either.
