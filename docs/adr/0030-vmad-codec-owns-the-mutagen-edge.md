---
status: accepted
---

# VMAD's Mutagen edge — parse *and* apply — lives in the Schema context

Every record field except one reaches Mutagen through a `ColumnSpec`: a reflected description of a field that carries both a read-extractor and a write-`Apply`, generated at startup by `SchemaReflector` ([ADR-0005](0005-reflection-driven-schema.md)). VMAD is the exception. Scripts and their properties are not a reflectable field shape — a property's type is data in the record, not a static type on a Mutagen class — so VMAD opted out of the reflection pipeline and got no `ColumnSpec` equivalent.

What it got instead was the same knowledge, written three more times. The VMAD **property-type taxonomy** (`Bool`/`Int`/`Float`/`String`/`Object`, the scalar arrays, `ArrayOfObject`, `Struct`/`ArrayOfStruct`, `Variable`/`ArrayOfVariable`) was independently encoded in the index walk's 12-case parse switch, the plugin writer's property-construction factory and struct-member builders, and the edit orchestrator's private set of editable types. Adding or changing one property type meant a coordinated edit across all three, with nothing to make a missed site fail loudly.

**`VmadCodec` (in `Schema/`) owns VMAD's Mutagen edge: parse (Mutagen → model), apply (model → Mutagen), the property-type taxonomy, and the editability policy.** It is what `ColumnSpec` is for reflected fields, hand-written because reflection cannot produce it. A new or changed VMAD property type is now a change to one file.

The codec does no I/O — no SQL, no disk — and it does not know about field paths. Its apply surface is name-addressed (`ApplyFieldValue(record, scriptName, propName, value)`, `ApplyScriptOp`, `ApplyPropertyOp`), so `VmadPath` stays in `Edits/` and the Schema context gains no dependency on Edits.

## Why apply belongs in Schema

Placing *write* logic in a context named for schema is the surprising part of this decision, so it is the part worth stating plainly: `MEditService/CLAUDE.md` already assigns `Schema/` "static knowledge of Mutagen record types — **read and write**", and `ColumnSpec` has always carried an `Apply` delegate alongside its extractor. Read and write knowledge of a field shape are the same knowledge — how a `Struct`'s members nest inside an unnamed `ScriptEntry` wrapper is one fact, and a codebase that states it once in parse and again in apply will eventually state it two different ways. VMAD is the field shape that opted out of reflection; consolidating it here gives it the treatment reflected fields already get.

The context boundaries this respects:

- **Records** keeps the index. The codec returns a property's type, flags, leaf value, per-element values, struct JSON, and the FormKeys it references with paths *relative to the property*; `VmadIndexer` lays that out as `vmad_properties` / `vmad_property_list_items` rows and prefixes ref paths with `VMAD\<Script>\<Prop>`. DuckDB hydration consults the codec's taxonomy instead of re-encoding the type set, but the row mapping itself does not move.
- **Edits** keeps orchestration. `PluginWriter` still backs up the target plugin before writing ([ADR-0008](0008-timestamped-binary-backups.md)), sequences the apply passes, and routes a change by path shape; it no longer knows how any VMAD property type is constructed or written.

## Alternatives rejected

**A shared taxonomy lookup table only.** Extract the type set and element-type mapping, leave parse and apply where they are. Cheap and non-invasive. Rejected: the type set was the least of the duplication. Parse and apply would still each carry a full per-type dispatch, so adding a property type would still be a three-file change — the ticket's actual complaint — and the taxonomy table would be a fourth place to keep in sync.

**A codec that also owns the DuckDB row mapping.** Tempting, because the model → rows step is the other half of "what a property type means". Rejected: it crosses into the Records context's ownership of the index. The storage layout of a property (which typed column a value lands in, how list items key back to their property) is an index design decision that should be free to change without touching VMAD semantics, and vice versa. The codec stops at the Mutagen edge.

## Consequences

- `VmadCodec` is round-trip testable as a unit (`Parse` → struct JSON → `ApplyValue` → `Parse` yields the same JSON) with no index-and-write integration run, which is how the taxonomy is now pinned.
- `PluginWriter` loses ~440 lines (1004 → 569); `VmadIndexer`'s parse switch and `EditOrchestrator`'s private editable-type set are gone.
- The codec returning `null` from `Parse` is how "this property type has no model representation" is reported; `VmadIndexer` decides that this deserves a warning, keeping logging out of Schema.
- `VmadConflictClassifier` (Queries) still maps model types to wire *kinds* for the compare view. That is presentation vocabulary, not Mutagen knowledge, and deliberately stays put.
</content>
