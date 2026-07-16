---
status: accepted
---

# A change group is a derived dependency closure, not a stored batch

ADR-0017 introduced the `ChangeGroup` as "a named set of `pending_changes` rows that form a logically indivisible operation", stored as a `change_groups` table plus a nullable `group_id` column, and assigned by whichever staging path created it. Changes with `group_id IS NULL` were "standalone field edits" — a distinct, ungrouped kind.

**There is no such thing as an ungrouped change.** A fully atomic standalone change is a group of one.

The purpose of a change group is not to record which command staged what. It is to prevent one specific failure: the user makes a change, makes further changes that depend on it, then partially rolls back and is left with invalid data — a dangling FormLink, a field on a record that no longer exists, a reference into a master that is no longer there. A group is therefore **the set of pending changes that must travel together because reverting a subset would invalidate the rest**. That is a property *derived from* the dependencies between changes, not a label applied at staging time.

Once grouping is defined that way, `change_groups` and `group_id` are revealed as a cache of a computation whose every column is already derivable from the member changes: `operation` is the dominant `change_type` among members (lifecycle ops win over `field_edit`); `description` is the originating change's `description`; `created_at` is `min(changed_at)`; and `id` exists only to link rows. Both are deleted. **A change group is a connected component of the pending-change dependency graph.** `pending_changes` holds the nodes, `pending_form_references` holds the edges, and the group falls out.

Two changes are adjacent when any of three edge rules holds:

1. **B references a FormKey that A brings into or out of existence** — A is a `$create`, `$delete`, or `$renumber` on FormKey T, and B holds a reference to T. This single rule subsumes ref-to-pending-create, the delete-nullification cascade, and renumber's cascading reference updates, which were three separately hand-grouped staging paths.
2. **B edits a record that A creates** — same `(form_key, plugin)`, where A's `change_type` is `create`.
3. **B references a record reachable only via a master that A adds** — a plugin-level rather than FormKey-level dependency.

Groups have no identity of their own. Save and revert take a *change* id and act on its component: "save this change and everything it is entangled with."

## Why

The stored form put the same fact in three places — the edge table, the `group_id` column, and the `change_groups` row — and made every staging path independently responsible for computing the right `group_id`. Six paths had that responsibility (`StageEdit`, `CopyRecordTo`, `StageMissingMasters`, create, delete, renumber). One of them got it wrong: `StageEdit` assigned `null` for an ordinary field edit, which — because every read and every save path keyed on `group_id` — made the single most common operation in the editor invisible in the Pending Changes tree and impossible to write to disk (#112). The bug was not a slip. It is what a denormalization with six writers produces.

Deriving grouping makes that bug class structurally impossible: there is no group to forget to assign, and a group of one is not a special case handled somewhere but an isolated node, which is simply what a node with no edges is. The grouping policy moves from six implicit sites into one explicit rule that can be read and tested directly.

The cost is a recursive CTE per read rather than an indexed column lookup. Pending sets are user-scale — tens of changes, occasionally hundreds — so this is not a consideration.

## Alternatives rejected

**Keep `group_id`, and have `StageEdit` mint a group of one.** Fixes #112's symptom in an afternoon. Rejected: it adds a seventh site that must remember to assign a group correctly, paying the full maintenance cost of a concept this ADR establishes does not exist. If ungrouped changes are not real, the column recording groupings should not be either.

**Derive without any group concept — closures computed per direction.** Saving B requires saving what B depends on; reverting A requires reverting what depends on A. The precise model uses the directed closure in each direction rather than the undirected connected component. Rejected for now as a refinement, not a foundation: the component is conservative in the safe direction (it may save or revert slightly more than strictly necessary, never less), and "these changes travel together" is one rule a user can hold in their head, where two closure directions is two. Revisit if partial-save granularity proves to matter.

**An explicit `indivisible` flag on groups.** Duplicates what `change_type` already encodes.

**Group membership by group size (`size > 1` blocks).** Rejected: a delete group whose cascade happened to have exactly one member would silently stop blocking. Size is a coincidence, not a meaning.

## Consequences

- `change_groups` and `pending_changes.group_id` are dropped, along with `StageGroup`, `GetGroupIdForRecord`, `GetCreateGroupIdForAny`, and `PendingChangeUpsert.GroupId`.
- The `BlockedByGroup` guard is rewritten. Today it blocks a field edit when the record has any change with a non-null `group_id`, which conflates *has a group* with *is pending a lifecycle op*. Under this ADR every change has a group, so that conflation would make every record read-only after one edit. The guard keys on `change_type` ∈ {`delete`, `renumber`} on the subject record — the semantic reason a field edit is incoherent — not on group membership.
- ADR-0017 is superseded in part: §4's rule that `DELETE /changes/{id}` returns 409 for any change with a non-null `group_id` becomes 409 only when the change's component has more than one member. §5's panel design stands and is the target UX. §1–§3 (DuckDB storage, field-level granularity, upsert-preserving-`OldValue`) are unaffected.
- `operation` graduates from a display string to a derived value with defined precedence: lifecycle ops dominate `field_edit`.
- Save and revert endpoints key on a member change id rather than a group id.
- The three edge rules are the single place grouping policy lives. A new dependency kind is a new edge rule, not a new assignment site.
</content>
</invoke>
