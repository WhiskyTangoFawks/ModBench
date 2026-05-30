# mEdit

A VS Code extension + local C# service for viewing, editing, and comparing Bethesda plugin files (`.esp`/`.esm`/`.esl`).

## Stack

**Backend** — C# ASP.NET Core minimal API (`MEditService/`)
- Mutagen: plugin parsing/writing
- DuckDB: in-process record repository — the service's only read path for record queries
- Swashbuckle: OpenAPI spec auto-generation

**Frontend** — TypeScript VS Code extension + React webviews (`medit-vscode/`)
- API client generated from OpenAPI spec at build time

## Key Invariants

- Binary plugins on disk are source of truth; DuckDB is the service's read path — all record queries flow through `IRecordRepository`, not directly through Mutagen. Writes go through Mutagen to disk, then re-indexed into DuckDB to keep the repository current. Never write to DuckDB without also writing to disk first.
- Records table uses `(form_key, plugin)` composite key — one row per plugin that contains that FormKey
- DuckDB schema is reflection-generated at startup from Mutagen types
- Backend and extension are always started independently by the user
- The architecture must support all Mutagen-supported games (releases) without code changes, tests may use FO4 as the concrete game.

For rationale and alternatives considered, see [ARCHITECTURE.md](ARCHITECTURE.md).

## MEditService.Core Folder Structure

Each folder owns one responsibility. When adding code, place it where the ownership fits — not where the mechanism fits.

| Folder | Owns | Examples |
|--------|------|---------|
| `Session/` | The live game environment and its lifecycle | `GameSession`, `SessionManager`, `PluginMetadata` |
| `Schema/` | Static knowledge about Mutagen record types — both read and write | `SchemaReflector`, `RecordTableSchema`, `ColumnSpec`, `FieldMetadataMapper` |
| `Records/` | The DuckDB record index: inserting, querying, DDL, cache invalidation | `IRecordRepository`, `DuckDbRecordRepository`, `TableDdlBuilder`, `SessionCache` |
| `Queries/` | Answering application-level questions about records | `RecordQueryService`, `ConflictClassifier`, `Models` (DTOs) |
| `Edits/` | Staging and persisting user edits | `PendingChangeService`, `PluginWriter`, `SaveResult` |
| `Resolution/` | FormKey ↔ EditorID translation | `FormKeyResolver` |

**Placement rules:**

Editing a record is a three-layer process — keep each layer in its folder:
- **Column metadata** (`Schema/`) — `ColumnSpec` carries both the extractor (read) and Apply delegate (write) for each Mutagen field. Both are derived from the same type reflection and belong together. Do not split them.
- **Change orchestration** (`Edits/`) — `PluginWriter` decides which pending changes to apply and dispatches to `ColumnSpec.Apply`. It owns the write loop, not the field-level knowledge.
- **Save lifecycle** (`Session/`) — `SessionManager` triggers the save and owns the re-index step after a write. `PluginWriter` writes to disk and returns; it does not call back into the repository.

Additional rules:
- DTOs returned by endpoints live in `Queries/Models.cs` — not scattered per-folder.
- Dead or unintegrated code must be deleted, not left in place.

## References

`Mutagen/` contains a local clone of the [Mutagen](https://github.com/Mutagen-Modding/Mutagen) source, checked in for API reference only. Grep it to verify type names, method signatures, and interface hierarchies before using them. Do not modify mutagen files.

### Mutagen Documentation (`Mutagen/docs/`)

- [Index / Overview](Mutagen/docs/index.md)
- [Big Cheat Sheet](Mutagen/docs/Big-Cheat-Sheet.md) — quick API reference, start here
- **Plugins** — core record I/O
  - [Importing](Mutagen/docs/plugins/Importing.md)
  - [Exporting](Mutagen/docs/plugins/Exporting.md)
  - [ModKey, FormKey, FormLink](Mutagen/docs/plugins/ModKey,%20FormKey,%20FormLink.md)
  - [Create, Duplicate, and Override](Mutagen/docs/plugins/Create,-Duplicate,-and-Override.md)
  - [Interfaces](Mutagen/docs/plugins/Interfaces.md)
  - [Flags and Enums](Mutagen/docs/plugins/Flags-and-Enums.md)
  - [Translation Masks](Mutagen/docs/plugins/Translation-Masks.md)
- **Link Cache** — record resolution across plugins
  - [Overview](Mutagen/docs/linkcache/index.md)
  - [Record Resolves](Mutagen/docs/linkcache/Record-Resolves.md)
  - [ModContexts](Mutagen/docs/linkcache/ModContexts.md)
  - [Previous Override Iteration](Mutagen/docs/linkcache/Previous-Override-Iteration.md)
- **Load Order**
  - [Overview](Mutagen/docs/loadorder/index.md)
  - [Winning Overrides](Mutagen/docs/loadorder/Winning-Overrides.md)
- **Environment** — game path / load order construction
  - [Environment Construction](Mutagen/docs/environment/Environment-Construction.md)
  - [Game Locations](Mutagen/docs/environment/Game-Locations.md)
- [Best Practices](Mutagen/docs/best-practices/TryGet-Concepts.md)

## Conventions

### Test-Driven Development
Always do /test-driven-development when fixing bugs to developing new features.

## Manual Testing
Use `/manual-test` to run the full manual test sequence.