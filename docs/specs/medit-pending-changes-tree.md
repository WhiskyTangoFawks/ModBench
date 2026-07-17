# mEdit Pending Changes tree — Surface Specification

**Status: Planned.** [ADR-0029](../adr/0029-pending-changes-tree-is-a-grouping-view.md)
supersedes ADR-0017 §5, which the shipped tree still reflects. What ships today: a flat,
non-expandable list of `change_groups` rows with inline Save/Revert. Ordinary field edits are
absent from it entirely (#112).

Editing context — operates on **records**, **FormKeys**, **plugins**, and **ChangeGroups**;
the Mod-Management vocabulary ("mod", "loadout", "deploy") belongs to the sibling surfaces,
not here ([CONTEXT-MAP.md](../../CONTEXT-MAP.md), glossary: [CONTEXT.md](../../CONTEXT.md)).

One of the mEdit view's surfaces — see [medit.md](medit.md) for the shared session lifecycle,
vocabulary, and architecture seams. Siblings:
[Plugins tree](medit-plugins-tree.md) (which browses staged edits in context, under the
`pending-changes` filter preset — this view deliberately does not),
[Record editor panel](medit-record-editor.md) (whose Pending column stages the changes this
view groups), [Referenced By panel](medit-referenced-by.md).

## Problem Statement

A mod author patching a loadout accumulates staged edits before writing any of them to disk.
Most are independent — change a weapon's damage, change an NPC's height — and each can be
committed or thrown away on its own. Some are not: renumbering a FormID rewrites every
reference to it; deleting a record nullifies the FormLinks pointing at it; an edit can
reference a record that itself is not yet saved. Those edits **must travel together**, because
saving or reverting part of the set leaves the data invalid — a dangling FormLink, a field on
a record that no longer exists.

The author cannot see any of this. Nothing tells them which staged edits are entangled, how
far an entanglement reaches, or what a Save is actually about to write. Without that, the
choice to commit is made blind: the user either saves everything and hopes, or avoids
lifecycle operations because their blast radius is invisible.

## Solution

A sidebar `TreeView` below the Plugins tree, **organized by ChangeGroup** — the set of pending
changes that must be saved or reverted atomically, derived as a connected component of the
pending-change dependency graph ([ADR-0028](../adr/0028-change-groups-are-derived-dependency-closures.md)).

This view exists to show **grouping, and nothing else** — it is the one fact about the pending
set that no other surface can show. "Which records have I touched, and what do they look like
in context" is a different question, already answered by the Plugins tree under the built-in
`pending-changes` filter preset. This view is deliberately not a second version of that, and
has no plugin → record → field hierarchy.

Most edits depend on nothing, so most of the tree is single edits shown as plain leaves. The
rare multi-member group — the reason the view exists — sorts to the top and expands to show
exactly what it will carry.

## User Stories

1. As a user, I want a tree listing everything I have staged and not yet written to disk —
   every field edit as well as lifecycle operations (create, delete, renumber) — so that if I
   edited it and haven't saved it, I can always find it in one place.
2. As a user, I want that tree organized by **ChangeGroup** rather than by plugin and record,
   so that it answers the one question no other surface can: what travels together.
3. As a user, I want to see a ChangeGroup and understand its scope at a glance — what
   operation it is, which record it is rooted at, and how many edits, records, and plugins it
   touches — so that I know what I am committing before I commit it.
4. As a user, I want to expand a ChangeGroup and see the individual edits it will apply, so
   that "these travel together" is something I can verify rather than take on trust.
5. As a user, I want the ordinary case — an edit nothing depends on — to appear as just that
   edit, with no group wrapper, so that the tree is not padded with ceremony around single
   edits.
6. As a user, I want multi-member groups sorted above single edits, so that the rare thing
   this view exists for is never buried under the common one.
7. As a user, I want to save or revert a ChangeGroup as a unit, so that I can commit related
   edits together and never half of them.
8. As a user, I want to save or revert everything at once, so that "I'm done" and "start over"
   are each one action.
9. As a user, I want to select several entries and save or revert the whole selection, so that
   committing the handful of independent edits I just made to one record is one gesture rather
   than one per edit.
10. As a user, I want single edits ordered so that one record's edits sit together, so that
    selecting them is one Shift-click rather than a hunt.
11. As a user, I want left-clicking any edit to open its record, so that the tree is somewhere
    I navigate from, not just a receipt.
12. As a user, I want to be told when reverting would break a group, and offered the whole
    group instead, so that I am never shown an error I cannot act on.
13. As a user, I want a partial-save failure (some plugins saved, some not) reported clearly
    with the group left intact and its unsaved changes re-queued, so that a failure never
    silently loses my work.
14. As a user, I want a failed refresh to say so, so that "no pending changes" never quietly
    means "we couldn't ask".
15. As a user, I want the tree to update as I stage and save, so that it is never telling me
    about a world that no longer exists.

## Implementation Decisions

- A second sidebar `TreeView` (`modbench.changeGroupTree`, "Pending Changes") stacked below
  the Plugins tree in the `modbench` view container, visible while
  `modbench.viewMode == 'editing'`. Sidebar placement follows
  [ADR-0027](../adr/0027-mo2-surfaces-map-to-native-vscode-views.md)'s stacked-tree pattern;
  ADR-0017 §5's bottom-panel location is superseded (ADR-0029).
- **Top-level nodes are ChangeGroups**, sorted with multi-member groups first, then single
  edits by plugin, then record.
- A **multi-member group** is expandable: labeled `{operation} {subject}`, with a
  `{N} edits · {M} records · {P} plugins` detail line and a chain icon. Children are its
  member edits, flat — groups are small, and the record count belongs on the detail line
  rather than being something the user recovers by counting nodes.
- A **group of one** gets no group wrapper: it renders as the edit itself, a top-level leaf
  labeled `{RecordType} / {EditorID} · {fieldPath}`, with a `{old} → {new}` detail line and its
  plugin.
- `operation` and `description` are **derived, not stored** — `operation` is the dominant
  `change_type` among members (lifecycle ops beat `field_edit`), `description` the originating
  change's (ADR-0028). A ChangeGroup has no id and no number to title a node with.
- **Left-click opens the record** — from an edit, its record. A group node contributes no
  command and simply expands.
- **Right-click a group node** (`pendingGroup`, of one or many): Save Group, Revert Group,
  both atomic on the component. **Member nodes** (`pendingGroupMember`) have no context menu —
  the group owns the actions, and offering a group action from a member invites the reading
  that it acts on that member alone.
- **Multi-select** (`canSelectMany`): Ctrl/Shift-click any number of top-level nodes; Save and
  Revert act on the whole selection, group by group. Same convention as the Plugins tree's
  batch actions. This is the only bulk path besides Save All.
- **Save and revert act on a ChangeGroup, a selection of them, or everything — never on part
  of one, and never on a record or plugin scope.** A group may span plugins, so those scopes
  could only be honoured by splitting a group (ADR-0029). Endpoints key on a **member change
  id** and act on that change's whole component (ADR-0028).
- **Reverting a member of a multi-member group is offered as Revert Group**, with a
  confirmation listing the members — the UI does not offer an action it knows will fail. The
  backend's 409 on a partial group revert remains as the guard against API misuse.
- Title-bar **Save All / Revert All** act on everything, hidden or disabled when nothing is
  staged.
- **Reveal**: the tree supports revealing an arbitrary change, so the Record editor panel's
  Pending column can navigate here (see [medit-record-editor.md](medit-record-editor.md)).
- Empty state: "No pending changes." A **failed fetch** yields an error node, never the empty
  state — an empty tree meaning "the request failed" is exactly the silently-wrong mental
  model [ADR-0026](../adr/0026-error-surfacing-policy.md) forbids. **Partial-save failure**
  (some plugins saved, some not) shows an error notification naming which saved and which
  failed; the group stays in the tree with its re-queued changes intact.
- All backend calls go through the generated `ApiClient`, never raw `fetch()`
  (`modbench/CLAUDE.md`). Group membership and member detail come from the backend; the
  frontend renders grouping, it does not derive it.

## Testing Decisions

- **Good tests assert external behavior, not implementation details** — for this surface that
  means observing the tree through `getChildren` / `getTreeItem` against a stubbed
  `ApiClient`: given a pending set, assert the node shape (which nodes are top-level, which
  expand, their labels and detail lines), and given an action, assert the calls made. Never
  construct nodes directly and never assert node internals.
- **Seam**: the tree provider's public surface against a stubbed `ApiClient` — Vitest,
  `npm run test:unit`, no backend and no VS Code. This is an existing seam.
- **Grouping semantics are the backend's responsibility** and are tested there (ADR-0028's
  edge rules; see `MEditService/CLAUDE.md`). This surface consumes representative responses
  as fixtures and must not re-assert what a group is.
- **Integration seam** (`npm run test:integration`): command registration only — any new
  command id goes in `EXPECTED_COMMANDS`.

## Out of Scope

- **A plugin → record → field hierarchy** — that duplicates the `pending-changes` filter
  preset on the Plugins tree; this view is organized by ChangeGroup (ADR-0029).
- **Per-plugin and per-record save/revert** — a ChangeGroup may span plugins, so those scopes
  could only be honoured by splitting a group (ADR-0029).
- **Grouping semantics** — settled in ADR-0028, implemented backend-side; not revisited here.
- **The `pending-changes` filter preset** itself — it belongs to the Plugins tree's record
  filter.
- **Persistence across backend restarts** — the pending set is session-scoped and lost on
  restart by design (ADR-0017 §1).

## Further Notes

- The design rationale — why grouping rather than a record hierarchy, why two scopes rather
  than five — lives in [ADR-0029](../adr/0029-pending-changes-tree-is-a-grouping-view.md), not
  here.
- This surface and the Record editor panel's Pending column are the two pending-changes
  surfaces. Neither browses records by plugin; that is the Plugins tree under the
  `pending-changes` filter.
