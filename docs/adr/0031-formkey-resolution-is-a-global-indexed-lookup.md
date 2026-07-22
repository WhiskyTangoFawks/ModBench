---
status: accepted
---

# FormKey resolution is a global indexed lookup, resolved server-side into every response that carries a FormKey

Three read surfaces need to know, for a given FormKey value, whether it resolves to a record in the
index and — if so — that record's EditorID and type: the compare grid's EditorID hyperlinks
(`docs/specs/medit-record-editor.md` field-rendering rule 2), the Ctrl-hover link affordance
([#111](#), gated per [ADR-0026](0026-error-surfacing-policy.md) so the affordance never
advertises a dead link), and the Pending Changes tree's `{RecordType} / {EditorID} · {fieldPath}`
leaf label. None of the three has this data today — `FieldDiff`, `PendingChange`, and
`VmadPropertyDiff` all carry a FormKey as a bare string.

Resolution already happens once, narrowly: `CheckErrorBuilder` resolves a FormKey to flag it as
`<Error: Could not be resolved>` or a wrong-type mismatch, via `DuckDbRecordRepository.FindRecordType`
— a scan over every record-type table (`SELECT 1 FROM "{tableName}" WHERE form_key = $1 LIMIT 1`,
repeated per table until one hits) because no table has an index on `form_key`. This is affordable
as an occasional diagnostic on `CompareOverride.Fields` (memoized per single record read) but is the
wrong cost shape to run per FormKey, per field, per plugin, across every record in a `GetCompare`/
`GetChanges` response — which is what all three consumers need.

## Decision

**A new global lookup — FormKey → (record type, EditorID) — populated once per record at index time,
queried in O(1).** This is the same shape as the existing `form_references` table (`Records/`,
indexed on `target_form_key`, already carries `record_type`/`editor_id` columns) — that table answers
"what refers to this FormKey", populated per *reference edge*; this one answers "what is this
FormKey", populated per *record*. Same context, same pattern, one row per record instead of one row
per reference.

`FieldDiff`, `PendingChange`, and `VmadPropertyDiff` gain a resolution signal per FormKey value,
reusing `CheckErrorBuilder`'s existing three-way distinction (not found / found, wrong type / found,
valid type) rather than collapsing it back to a boolean — a resolvable-but-wrong-type reference is
real information xEdit already surfaces (it allows the jump; the field's "could not be resolved" is
reserved for records absent from the index entirely). `Queries/` populates this signal by querying
the new lookup while building `FieldDiff`s, `PendingChange`s, and `VmadPropertyDiff`s, batched per
response rather than round-tripped per value.

Server-side resolution is not a closer tradeoff against a per-hover client lookup — it is the only
design that satisfies the affordance requirement as specified. The Ctrl-hover affordance must decide
whether to render *before* the hover occurs (a false affordance is the failure ADR-0026 exists to
prevent); a client-side per-hover lookup would still have to resolve before deciding to show the
affordance, so it does the same resolution work, just per-cell-hover instead of batched once per
response, and it cannot render the compare grid's EditorID hyperlinks at rest at all.

VMAD's FormKey-valued properties (`vmad_properties`/`vmad_property_list_items.form_key_value`)
reference ordinary major records, not VMAD-internal data, so they resolve through the same lookup —
no VMAD-specific index or resolver is needed. VMAD currently does zero resolution
(`VmadConflictClassifier`'s `LeafValue`/`Canon` string-concatenate the raw FormKey); this decision
brings it in line with the other two consumers rather than leaving it as a fourth, differently-shaped
gap.

## Alternatives rejected

**Per-hover client-side lookup (`GET /records/{formKey}`).** Rejected per the affordance argument
above — it cannot implement the spec as written (deciding affordance visibility requires resolution
before the hover, not during it), so it isn't actually a lazier design, just a differently-timed one
that also can't produce at-rest hyperlinks.

**Index every per-type table's `form_key` column instead of adding a lookup table.** Would make
`FindRecordType`'s existing scan O(#tables) → O(#tables) each O(1), still linear in table count per
resolution, and still requires re-deriving which table to query rather than reading it directly.
Rejected: a single global lookup answers "which table" and "what's the EditorID" in one read: the
DDL/maintenance cost of indexing ~130 per-type tables individually is larger than one new table.

**Resolve at write time into `form_references`' existing rows instead of a new table.**
`form_references` stores the *referrer's* type/EditorID, one row per reference edge, so it cannot
answer "what is this FormKey" for FormKeys that are never a reference target. Every record needs an
entry regardless of whether anything currently points to it. Rejected as the wrong cardinality for
this table.

## Consequences

- Indexing gains a small, fixed cost: one row per record in the new lookup, populated alongside the
  existing per-type table writes and `form_references` population.
- `FindRecordType`'s O(#tables) scan remains as-is for any caller that still needs it directly, but
  `CheckErrorBuilder` and the three read surfaces above should be migrated onto the new O(1) lookup —
  a caller retaining the old scan after this lands is a regression, not a valid choice.
- `FieldDiff`, `PendingChange`, and `VmadPropertyDiff` payload size grows by an EditorID string and a
  resolution tri-state per FormKey value. Cheap once the lookup is O(1); this is what makes
  server-side batch resolution affordable where it wasn't before.
- The compare grid, #111's affordance, and the Pending Changes tree each still decide their own
  rendering from the shared signal — this ADR fixes the missing data, not each consumer's presentation
  logic.
