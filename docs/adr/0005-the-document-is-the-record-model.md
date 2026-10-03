# The document is the record model

A record is one JSON document, reflected from Mutagen's own record types ([principles](../principles.md), *Mutagen's data*). It is the only record model: on the wire, on disk ([ADR-0006](0006-a-tracked-plugins-truth-is-its-source.md)) and in the record index ([ADR-0010](0010-the-record-index-is-a-duckdb-file.md)). There is no DTO beside it, no parsed struct for a special concern and no new wire shape for a new concern: a concern that looks special is a field, with a field's gestures.

## Consequences

- **Per-game knowledge is data, never code.** What reflection cannot answer about a game is a row validated against Mutagen's assembly. A game is then added in one place, and a fact never drifts from the assembly.
- **The webview holds no model of its own.** It renders the document and the field metadata mEdit sends, and it names no game.

## Alternatives rejected

- **A hand-written codec for conditions, or for the next concern that looks as divergent.** It is a second model. Mutagen's condition graphs reflect like any other shape.
- **One table per record type.** About 130 tables of DDL, every query across the load order a union over all of them, and a schema coupled to Mutagen's. It is a second model.
