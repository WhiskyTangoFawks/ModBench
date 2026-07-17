---
status: accepted
---

# The Pending Changes tree is a grouping view, not a filtered record tree

ADR-0017 §5 designed the pending-changes surface as a bottom panel tab containing a
plugin → record → field tree of every staged edit, with a separate `ChangeGroups` section
for multi-member operations, and save/revert offered at five scopes (field, record, plugin,
group, global). ADR-0028 reaffirmed that design as "the target UX" while replacing the
grouping model underneath it. Neither ADR revisited §5 against the model that replaced it.
Doing so now, §5 does not survive contact with it.

**The Pending Changes tree exists to show grouping, and nothing else.** A ChangeGroup is
the only thing about the pending set that cannot be seen from anywhere else in the product.
"Which records have I touched, and what do they look like in context" is already answered
by the Plugins tree under the built-in `pending-changes.sql` filter preset
([medit-plugins-tree.md](../specs/medit-plugins-tree.md) story 13) — a plugin → record
hierarchy, pruned to the
records with staged edits, in the surface built for browsing records. A second
plugin → record → field tree in a dedicated view is that same query, reimplemented, in a
worse query language, in a view with less context. The two surfaces divide by *question*,
not by data.

## The tree

ChangeGroups are top-level nodes, sorted first, and they expand to their member changes.
A group of one gets no group affordance — it renders as the edit itself, a leaf at top
level, because a wrapper around a single edit communicates nothing. Since most edits depend
on nothing, most of the tree is leaves; the rare multi-member group is what the view is for,
so it sorts above them and is never buried.

```
Pending Changes (14)
├── ⛓ Renumber  NPC_ / Bandit [001234:MyPatch.esp] → 001299
│      7 edits · 4 records · 2 plugins
│   ├── Renumber    NPC_ / Bandit [001234:MyPatch.esp] → 001299
│   ├── WEAP / Iron Sword · BoundWeapon    001234 → 001299    MyPatch.esp
│   └── CONT / Chest · Items[2].Item       001234 → 001299    OtherPatch.esp
├── NPC_ / Ulfric Stormcloak · Height      0.97 → 1.05        MyPatch.esp
└── WEAP / Iron Sword · Damage             8 → 10             MyPatch.esp
```

A group node is titled `{Operation} {subject}` and described by its scope —
`{N} edits · {M} records · {P} plugins` — which is the question the view answers. Both are
derived, per ADR-0028: `operation` is the dominant `change_type` among members, `description`
the originating change's. An edit is titled `{RecordType} / {EditorID} · {fieldPath}` and
described `{old} → {new}` with its plugin. Members inside a group stay flat rather than
re-nesting by record; groups run to a handful of edits, and the record count is on the scope
line rather than something the user counts nodes to recover.

## Actions

**Save and revert exist at exactly two scopes: a ChangeGroup, and everything.** ADR-0017 §5
also offered per-field, per-record, and per-plugin scopes. Under ADR-0028 those are not
expressible: a group may span plugins, so "save this plugin" either straddles a group
boundary — writing a half-applied cascade, the exact data corruption grouping exists to
prevent — or silently writes plugins the user did not name. A scope that cannot be honoured
is not a scope. This is the same category error as the record panel's `POST
/plugins/{plugin}/save`, a per-plugin save the change-group model never provided and the
backend never implemented.

Left-click opens the record: from an edit, its record; from a group node, nothing — it
expands, VS Code's default for a node contributing no command. Right-click a group node
(`pendingGroup`, whether of one or many) gives Save Group and Revert Group, both atomic on
the component. Title-bar Save All / Revert All cover everything.

Bulk work is **multi-select**, not a coarser scope. The tree sets `canSelectMany`;
Ctrl/Shift-click selects any number of top-level nodes and Save/Revert act on the whole
selection, group by group. This is the same convention the Plugins tree already uses for
batch actions ([medit-plugins-tree.md](../specs/medit-plugins-tree.md) story 2). It resolves
the one real ergonomic
cost of a strict two-scope rule — committing the several independent edits a user just made
to one record — without inventing a scope that can split a group: each selected node still
saves atomically, so N selected groups are N whole group saves. For this to be usable,
leaf edits sort by plugin, then record, so one record's edits are contiguous and
Shift-click reaches them in one gesture.

**Members of a multi-member group get no context menu.** The group node owns the actions.
Offering "Revert Group" from a member invites the reading that it reverts *that member* —
precisely the misconception ADR-0028's 409 guard exists to catch. Left-click still opens the
member's record, so the node is not inert.

## Why

The stored-batch model is gone, so a `ChangeGroups` *section* re-reifies it. ADR-0028
established that groups have no identity — they are recomputed per read, with no id and no
number to title a node with. A section listing them as though they were durable objects
teaches the model the ADR deleted, and forces a user asking "what did I change to Ulfric" to
look in two places while the counts double-count members across sections.

Every member of a cascade is a field on a record in a plugin, so the two-section split was
never load-bearing: a nullification is an ordinary field edit and reads perfectly well as a
leaf. The split existed to keep the plugin → record → field tree tidy — a tree this ADR
removes as redundant.

## Alternatives rejected

**Keep ADR-0017 §5's two-section tree.** Rejected: its plugin → record → field half
duplicates the `pending-changes.sql` filter, and its `ChangeGroups` half reifies an identity
ADR-0028 removed.

**Single plugin → record → field tree, groups shown as a badge on members.** Considered
seriously; it reads well and every change appears exactly once. Rejected for the same
redundancy: it is the pending-changes filter with extra steps, and it demotes grouping —
the one fact only this view can show — to a decoration.

**Per-plugin and per-record save, with a confirmation naming the other plugins a straddling
group would also write.** Preserves a genuinely useful action and satisfies ADR-0026 by
making the straddle explicit rather than silent. Rejected as a worse trade than deleting the
scope: a confirmation that routinely says "this will also write three plugins you didn't ask
for" is a scope the user cannot predict before invoking it. Save All already covers "write
everything", and per-group covers "write this unit".

**A per-record composite scope in the record panel — "save every group touching this record
here" — to spare the user right-clicking each of several independent edits.** Rejected:
multi-select solves the same ergonomic problem without a third scope. The composite is a
set-of-groups whose membership the user cannot see before invoking it, and it straddles
whenever one of the record's edits happens to be entangled; a selection is a set of groups
the user assembled and can see. Where a composite hides which groups it will expand to, a
selection *is* the groups.

**A bottom panel tab (ADR-0017 §5's location).** Rejected: §5's stated reason for refusing a
sidebar tree was that it "would require a dedicated sidebar view container" and "the sidebar
is already occupied by the plugin/record tree". [ADR-0027](0027-mo2-surfaces-map-to-native-vscode-views.md)
invalidated that premise by establishing the stacked-tree pattern — independently
collapsible trees sharing one container, as Mods and Plugins already do. The tree stacks in
the `modbench` container at no cost, and shipped that way.

## Consequences

- **ADR-0017 §5 is superseded in full** — location, structure, and action table. §§1–3
  (DuckDB session storage, field-level granularity, upsert-preserving-`OldValue`) are
  unaffected and remain the storage model; §4 remains superseded in part by ADR-0028.
- ADR-0028's "§5's panel design stands and is the target UX" no longer holds; the grouping
  model it introduced is what makes §5 unworkable.
- The Pending Changes tree stays a sidebar `TreeView` stacked in the `modbench` container,
  and gains `canSelectMany`.
- Node `contextValue`s reduce to `pendingGroup` and `pendingGroupMember`. ADR-0017 §5's
  `pendingPlugin`, `pendingRecord`, and `pendingField` describe a hierarchy that no longer
  exists.
- `POST /plugins/{plugin}/save` is not to be implemented; the record panel's dead call to it
  is removed rather than fixed.
- The pending-changes surfaces are the tree and the record panel's Pending column. Neither
  browses records by plugin — that is the Plugins tree under `pending-changes.sql`.
