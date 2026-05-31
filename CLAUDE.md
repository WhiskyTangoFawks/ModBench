# mEdit

A VS Code extension + local C# service for viewing, editing, and comparing Bethesda plugin files (`.esp`/`.esm`/`.esl`).

## Stack

**Backend** — C# ASP.NET Core minimal API (`MEditService/`)
- Mutagen: plugin parsing/writing
- DuckDB: in-process record index — the indexed read model of committed (on-disk) record data
- Swashbuckle: OpenAPI spec auto-generation

**Frontend** — TypeScript VS Code extension + React webviews (`medit-vscode/`)
- API client generated from OpenAPI spec at build time
- `openapi-fetch` typed client — all HTTP calls go through typed path strings, never raw `fetch()`

## Key Invariants

- Binary plugins on disk are the source of truth for committed record data. DuckDB is the indexed read model — the only read path for queries; all record queries flow through `IRecordRepository`, not directly through Mutagen. Staged changes not yet written to disk are buffered in `PendingChangeService` (in-memory only); DuckDB reflects only what is committed on disk. Writes go through Mutagen to disk first, then the affected plugin is re-indexed into DuckDB. Never write to DuckDB without first writing to disk.
- Records table uses `(form_key, plugin)` composite key — one row per plugin that contains that FormKey
- DuckDB schema is reflection-generated at startup from Mutagen types
- Backend and extension are always started independently by the user. The extension never spawns the backend process — it polls `GET /health` until the backend is up, then emits `attached`. If the backend is not running, the status bar says so and the user starts it manually.
- The architecture must support all Mutagen-supported games (releases) without code changes, tests may use FO4 as the concrete game.

For rationale and alternatives considered, see [ARCHITECTURE.md](ARCHITECTURE.md).

## MEditService.Core Folder Structure

Each folder owns one responsibility. When adding code, place it where the ownership fits — not where the mechanism fits.

| Folder | Owns | Examples |
|--------|------|---------|
| `Session/` | The live game environment and its lifecycle | `GameSession`, `SessionManager`, `PluginMetadata` |
| `Schema/` | Static knowledge about Mutagen record types — both read and write | `SchemaReflector`, `RecordTableSchema`, `ColumnSpec`, `FieldMetadataMapper` |
| `Records/` | The DuckDB record index: inserting committed records, querying, DDL | `IRecordRepository`, `DuckDbRecordRepository`, `TableDdlBuilder`, `SessionCache` |
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

## medit-vscode Module Map

Each module owns one responsibility. `extension.ts` is the composition root — it wires everything together but contains no business logic.

| Module | Owns | Key rule |
|--------|------|----------|
| `extension.ts` | Wiring: creates instances, registers VS Code commands, handles prompts | No business logic; prompts user then delegates to `SessionController` |
| `SessionController` | HTTP orchestration for commands (create plugin, copy record, load session) | No VS Code types in its interface — MCP tools can call it directly |
| `SessionWizard` | Multi-step session setup flow (game path detection → `POST /session/load`) | Returns `boolean` — true if a session is now loaded |
| `BackendManager` | Polls `GET /health` until the C# backend is available; emits `'attached'` or `'disconnected'` | Never spawns the backend process |
| `PluginRepository` | HTTP adapter for plugin/record data (`GET /plugins`, `/record-types`, `/records`) | Interface: `PluginRepository`; implementation: `ApiPluginRepository` |
| `PluginTreeProvider` | VS Code sidebar tree: maps repository data to tree nodes; owns page cache (UI state) | Takes `PluginRepository`, not `ApiClient` — page cache keyed on `"plugin::recordType"` strings |
| `ApiClient` | Typed `openapi-fetch` client factory | Type alias for the generated client; DTOs defined here |
| `GamePathDetector` | Platform-specific game path discovery (Steam VDF / Windows registry) | Pure utility; returns `GamePaths | null` |
| `webviewHtml` | Generates the HTML shell for the record editor webview panel | No VS Code types except `Uri` string |

**Placement rules for new frontend code:**

- **Business logic belongs in the C# backend.** The frontend is a thin client — it sends commands and renders results. If you are tempted to put domain logic in TypeScript, put it in C# and expose an endpoint instead.
- **Context menu actions** are declared statically in `package.json`. Which actions are available for a specific item is controlled by the `contextValue` of the tree node, which is set from backend-returned metadata. The backend decides what's allowed; the frontend decides how to present it.
- **New commands** follow this pattern: prompt the user in `extension.ts`, then call a `SessionController` method with explicit arguments. The controller method has no VS Code dependency and can be called directly by MCP tools.
- **New data queries** go through `PluginRepository`. Add a method to the `PluginRepository` interface, implement it in `ApiPluginRepository`, and test `ApiPluginRepository` without VS Code.

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

## Development Workflow

All commands run from `medit-vscode/`.

```bash
npm run test:unit       # run Vitest unit tests (no backend required)
npm run build           # type-check + bundle extension + webview
npm run generate-api    # regenerate src/generated/api.ts from live backend at :5172
```

`generate-api` requires the C# backend to be running. Run it after adding or changing any C# endpoint. It rewrites `src/generated/api.ts` — commit the updated file alongside your C# changes.

## C# endpoint invariant: every endpoint must declare its response types

Every endpoint in `MEditService.Api/Endpoints/` must have `.Produces<T>()` for its success response and `.ProducesProblem(status)` for every error response. This is how Swashbuckle generates typed response bodies in `api.ts`. Without it, the generated spec emits `content?: never` for that endpoint, which silently removes the response type from the TypeScript client — callers get `never` instead of the actual type.

```csharp
// Correct — Swashbuckle knows the body shape
app.MapGet("/records", ...)
    .WithName("GetRecords")
    .Produces<PagedResult<RecordSummary>>()          // 200 success
    .ProducesProblem(404);                           // 404 error

// Wrong — Swashbuckle has no idea what comes back
app.MapGet("/records", ...)
    .WithName("GetRecords");
```

Additional rules:
- Never return anonymous types (`new { ... }`). Use a named record from `Queries/Models.cs` so Swashbuckle can reflect the type.
- After any endpoint change, run `npm run generate-api` (from `medit-vscode/`, requires backend running) and commit the updated `src/generated/api.ts`.

## Type mapping: PluginMetadata and RecordSummary

`PluginMetadata` (in `ApiClient.ts`) is the canonical frontend type — non-nullable, used everywhere. It is **not** the generated `PluginResponse` type. `ApiPluginRepository.getPlugins()` maps `PluginResponse → PluginMetadata` via `toPluginMetadata()` in `PluginRepository.ts`.

**When adding a field to the C# `PluginResponse`:**
1. Add it to the C# model
2. Run `generate-api` — the field appears in `PluginResponse` in `api.ts`
3. Add the field to `PluginMetadata` in `ApiClient.ts`
4. Add the mapping in `toPluginMetadata()` in `PluginRepository.ts` — the compiler will tell you this is incomplete if you forget

`RecordSummary` (in `ApiClient.ts`) is currently manual — `GET /records` was missing its `.Produces<T>()` annotation, which has now been added. Once `generate-api` is run against the updated backend, `RecordSummary` and `PagedResult` will appear in `api.ts` and the manual type plus the cast in `ApiPluginRepository.getRecords()` should be replaced with a `toRecordSummary()` mapper following the same pattern as `toPluginMetadata()`.

## Adding a new command (end-to-end)

Use this checklist when adding any user-facing action, whether triggered from the command palette, a button, or a right-click menu.

**1. Backend** (if new data or mutation is needed)
- Add a C# endpoint in `MEditService/`
- Run `npm run generate-api` to pull the new path into `src/generated/api.ts`

**2. Frontend logic** (no VS Code types)
- If it **reads data**: add a method to the `PluginRepository` interface and implement it in `ApiPluginRepository`. Test in `ApiPluginRepository.test.ts`.
- If it **executes a command**: add a method to `SessionController`. Test in `SessionController.test.ts`. The method takes explicit arguments — no VS Code types.

**3. VS Code wiring** (in `extension.ts` and `package.json`)
- Register the command in `package.json` under `contributes.commands`:
  ```json
  { "command": "mEdit.myAction", "title": "My Action", "category": "mEdit" }
  ```
- For a **context menu item** on a tree node, also add it under `contributes.menus["view/item/context"]`:
  ```json
  { "command": "mEdit.myAction", "when": "viewItem == 'plugin'", "group": "mEdit@1" }
  ```
  The `when` clause matches the `contextValue` set on the tree node in `PluginTreeProvider.ts`. Current values: `"plugin"`, `"pluginImmutable"`, `"recordType"`, `"record"`.
- Register the handler in `extension.ts`: prompt the user for any needed input, then call the `SessionController` or `PluginRepository` method.

**4. Tests**
- Run `npm run test:unit` to confirm green before and after.
- If the new module imports from `vscode`, add `vi.mock('vscode', ...)` at the top of its test file — see `PluginTreeProvider.test.ts` for the mock shape.

## Conventions

### Test-Driven Development
Always do /test-driven-development when fixing bugs to developing new features.

## Manual Testing
Use `/manual-test` to run the full manual test sequence.