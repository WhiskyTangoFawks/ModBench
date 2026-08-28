---
status: accepted
---

# Masters are lifecycle-derived from content, never user-declared

A permitted divergence from [ADR-0034](0034-xedit-is-the-ux-reference-for-the-record-editor.md).

## Context

xEdit exposes masters management as three direct user actions on a plugin's file node: Add
Masters, Sort Masters, Clean Masters. An early slice built the first of these for mEdit — a
validated, add-only `masters` field on the header record — and deferred Sort/Clean/Remove to
future scripts on the assumption they were expensive, whole-plugin operations in the same risk
class as FormID renumbering. That matches xEdit, which patches stored FormID bytes in place, so
reordering or removing a master requires walking and rewriting every reference in the file.

Design review (#283) surfaced a real use for a manually-declared, content-free master: adding an
otherwise-unused plugin as a master purely to pin load order. This is a real modding pattern, but
it's a load-order concern — Mod Management's job — expressed invisibly inside an Editing-context
object, per-plugin, unauditable from the surface that owns ordering (`plugins.txt`), and it
silently breaks whenever the referenced plugin updates.

Separately, this codebase's write pipeline doesn't share xEdit's risk profile. Mutagen rebuilds a
plugin's outgoing master list from its live object graph on every write rather than patching
stored bytes, and re-derives every FormID's local master-index from that fresh list. There is no
"declared masters drifted out of sync with what's on disk" failure mode here — sort and clean are
the pipeline's default, unconditional behavior, not separate operations.

## Decision

**A plugin's masters are wholly derived from its content, never directly user-editable.** Nothing
— not a native command, not a script — declares a master ahead of the content that requires it,
and nothing removes, reorders, or bulk-cleans a master directly. `masters` is read-only: visible on
the header record, computed as **Effective masters** — the compiled masters unioned with the origin
plugins referenced by the plugin's uncommitted source changes (CONTEXT.md). Save & Compile always
writes exactly that set ([ADR-0041](0041-manual-git-tracking-compile-from-text.md): deriving the
masters list is one of the two things the format forces compile to derive).

This makes Add, Sort, and Clean disappear as distinct operations rather than gain a UI. Add is
automatic: a copy or edit that references another plugin's record makes that plugin a master at
the next compile. Sort and Clean are inherent to every compile — never visible as an edit, not
scriptable as a separate primitive.

## Consequences

- There is no manual "Add Master…" command, no picker, and no append-only validation — there is no
  direct edit path for `masters` to validate.
- A modder who wants to force one plugin to load after another with no real content dependency
  has no supported way to do it from mEdit — that is expressed in Mod Management's own load-order
  surface, not by hand-declaring a master.
- A master reference naming no loaded plugin is classified and flagged, never deactivated
  ([ADR-0037](0037-unresolvable-masters-are-indexed-and-flagged.md)).
