---
status: accepted
---

# FormKey resolution is a global indexed lookup, resolved server-side into every response that carries a FormKey

Several read surfaces need to know, for a given FormKey value, whether it resolves to a record in
the index and — if so — that record's EditorID and type: the compare grid's EditorID hyperlinks
(`docs/specs/medit-record-editor.md` field-rendering rule 2), the Ctrl-hover link affordance
(gated per [ADR-0026](0026-error-surfacing-policy.md) so the affordance never advertises a dead
link), the Referenced By tree, and the Dangling / Type-Mismatched FormLink diagnostics.

## Decision

**A global lookup — FormKey → (record type, EditorID) — populated once per record at index time,
queried in O(1)**: the `form_lookup` index table (ADR-0005), extracted from the documents at
ingest. This is the same shape as `form_references` (indexed on `target_form_key`, carrying
`record_type`/`editor_id`) — that table answers "what refers to this FormKey", one row per
*reference edge*; this one answers "what is this FormKey", one row per *record*.

`FieldDiff` and `VmadPropertyDiff` carry a resolution signal per FormKey value, using a three-way
distinction (not found / found, wrong type / found, valid type) rather than a boolean — a
resolvable-but-wrong-type reference is real information xEdit surfaces (it allows the jump; "could
not be resolved" is reserved for records absent from the index). `Queries/` populates the signal
by querying the lookup while building diffs, batched per response rather than round-tripped per
value.

Server-side resolution is the only design that satisfies the affordance requirement: the
Ctrl-hover affordance must decide whether to render *before* the hover occurs (a false affordance
is the failure ADR-0026 exists to prevent), and the compare grid's EditorID hyperlinks must render
at rest.

VMAD's FormKey-valued properties reference ordinary major records, not VMAD-internal data, so they
resolve through the same lookup — no VMAD-specific resolver.

## Alternatives rejected

- **Per-hover client-side lookup (`GET /records/{formKey}`)** — cannot implement the spec as
  written: deciding affordance visibility requires resolution before the hover, not during it, and
  it cannot produce at-rest hyperlinks. Not lazier, just differently timed.
- **Scanning the record tables per resolution** (the pre-lookup implementation, when the index was
  ~130 reflected per-type tables with no `form_key` index): `SELECT 1 FROM "<table>" WHERE
  form_key = $1` repeated per table until one hit. Affordable as an occasional diagnostic,
  wrong cost shape per FormKey, per field, per plugin, across a whole compare response. Indexing
  each table's `form_key` instead would still have been linear in table count.
- **Resolve into `form_references`' existing rows** — it stores the *referrer's* type/EditorID,
  one row per edge, so it cannot answer "what is this FormKey" for a FormKey nothing points at.
  Wrong cardinality.
