# The record index stores documents

The record index holds every record as a document in one table: the record's source JSON, the same bytes
as its source file ([ADR-0005](0005-the-document-is-the-record-model.md),
[ADR-0006](0006-decompilation-is-provably-faithful.md)), beside its identity columns.
No record type has a table of its own. The extracted index tables, form lookup, references and
placement, are populated from the documents at ingest.

## Strategic invariants

1. **The relational shape is a generated view, for the SQL door only.** Reflection over Mutagen's
   record types generates one `json_extract` view per type, named after the type and carrying
   scalar leaves only, so that user filter SQL reads a relational schema. The views are created
   on the first filter, not when the record index opens, because only user SQL reads them.
2. **Typed reads reconstitute; they never read the views.** Every typed read deserializes the
   document through the codec and runs the same extract delegates the views are generated from,
   so the values are identical by construction and cannot drift.
3. **A field is promoted to a real column only when measurement demands it.** A filter probe over
   a full load order found the views fast enough without any.

## Alternatives rejected

- **One reflected wide table per record type**, the original design. About 130 tables of DDL to
  maintain, every whole-load-order query a union over all of them, nested lists silently dropped
  where the reflector had no mapping, and a schema coupled to Mutagen's at DDL time. Once the
  source became the record's text, the document was the natural row, and the only field-predicate
  consumer left was user filter SQL, which the views serve.
- **Typed reads through the views.** A second decode path that could drift from the codec.
