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

- Binary plugins on disk are the source of truth for committed record data. DuckDB is the indexed read model — the only read path for queries; all record queries flow through `IRecordRepository`, not directly through Mutagen. Staged changes are buffered in a separate table.
- Records table uses `(form_key, plugin)` composite key — one row per plugin that contains that FormKey
- DuckDB schema is reflection-generated at startup from Mutagen types
- Backend and extension are always started independently by the user.
- The architecture must support all Mutagen-supported games (releases) without code changes, tests may use FO4 as the concrete game.

For rationale and alternatives considered, see [docs/adr/](docs/adr/). For the full frontend functional design (tree surfaces, record editor, field rendering rules), see [docs/UI_SPEC.md](docs/UI_SPEC.md).

## MEditService.Core Folder Structure

| Folder | Owns | Examples |
|--------|------|---------|
| `Session/` | The live game environment and its lifecycle | `GameSession`, `SessionManager`, `PluginMetadata` |
| `Schema/` | Static knowledge about Mutagen record types — both read and write | `SchemaReflector`, `RecordTableSchema`, `ColumnSpec`, `FieldMetadataMapper` |
| `Records/` | The DuckDB record index: inserting committed records, querying, DDL | `IRecordRepository`, `DuckDbRecordRepository`, `TableDdlBuilder`, `SessionCache` |
| `Queries/` | Answering application-level questions about records | `RecordQueryService`, `ConflictClassifier`, `Models` (DTOs) |
| `Edits/` | Staging and persisting user edits | `PendingChangeService`, `PluginWriter`, `SaveResult` |
| `Resolution/` | FormKey ↔ EditorID translation | `FormKeyResolver` |

Place code where **ownership** fits, not where the mechanism fits. Record editing is three layers: field metadata in `Schema/` (`ColumnSpec` carries both read extractor and Apply write delegate — keep them together), write loop in `Edits/` (`PluginWriter`), save lifecycle in `Session/` (`SessionManager` triggers save and re-index; `PluginWriter` writes to disk and returns without calling back into the repository). DTOs live in `Queries/Models.cs`. Dead code must be deleted.

## medit-vscode Module Map

`extension.ts` is the composition root — wires everything together, contains no business logic.

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

**Placement rules:**
- Business logic belongs in C#. Frontend is a thin client — send commands, render results.
- Context menu availability is controlled by tree node `contextValue` (set from backend metadata). Current values: `"plugin"`, `"pluginImmutable"`, `"recordType"`, `"record"`.
- New commands: prompt in `extension.ts`, delegate to `SessionController` (explicit arguments, no VS Code types).
- New data queries: add to `PluginRepository` interface, implement in `ApiPluginRepository`, test without VS Code.
- Before any new UI surface: read `docs/UI_SPEC.md` first. If the spec doesn't cover it, add it there before implementing.

## References

`Mutagen/` — local clone checked in for API reference only. Grep to verify type names, method signatures, and interface hierarchies. Do not modify.

`TES5Edit/` — local clone (Pascal) for record/field definitions. `wbDefinitionsFO4.pas` for FO4 records; `wbArrayS` = sorted array, `wbArray` = unsorted. Do not modify.

Mutagen docs: start with `Mutagen/docs/Big-Cheat-Sheet.md`; full topic index at `Mutagen/docs/index.md`.

## Development Workflow

All commands run from `medit-vscode/`.

```bash
npm run test:unit        # run Vitest unit tests (no backend required)
npm run test:integration # run integration tests inside a real VS Code process (~10s, no backend required)
npm run build            # type-check + bundle extension + webview
npm run generate-api     # regenerate src/generated/api.ts from live backend at :5172
```

`generate-api` requires the C# backend to be running. Run it after adding or changing any C# endpoint — commit the updated `src/generated/api.ts` alongside your C# changes.

### Integration tests (`src/test/integration/extension.test.ts`)

Run inside a real VS Code process via `@vscode/test-cli` against a mock HTTP server (port 15172) — no real backend needed.

**Update when:**
- **Adding a command** — add the command ID to `EXPECTED_COMMANDS`. This is the primary regression guardrail.
- **New `extension.ts` behavior** — add a test calling `executeCommand` and asserting VS Code state.
- **Do not add** integration tests for logic outside `extension.ts`. `SessionController`, `PluginRepository`, `BackendManager`, `PluginTreeProvider` are unit-tested without VS Code — keep it that way.

## C# Endpoint Invariant

Every endpoint in `MEditService.Api/Endpoints/` must have `.Produces<T>()` for its success response and `.ProducesProblem(status)` for every error response. Without it, Swashbuckle emits `content?: never` — TypeScript callers get `never` instead of the actual type. Never return anonymous types (`new { ... }`); use a named record from `Queries/Models.cs`.

## Type Mapping: PluginMetadata

`PluginMetadata` (in `ApiClient.ts`) is the canonical frontend type — not the generated `PluginResponse`. `ApiPluginRepository.getPlugins()` maps `PluginResponse → PluginMetadata` via `toPluginMetadata()` in `PluginRepository.ts`.

When adding a field to `PluginResponse`: add to C# model → run `generate-api` → add to `PluginMetadata` in `ApiClient.ts` → add mapping in `toPluginMetadata()`.

## Adding a New Command (End-to-End)

1. **Backend** — add C# endpoint with `.Produces<T>()` and `.ProducesProblem(status)`; run `npm run generate-api`
2. **Frontend logic** — data reads go through `PluginRepository` (test in `ApiPluginRepository.test.ts`); mutations go through `SessionController` (test in `SessionController.test.ts`)
3. **VS Code wiring** — register in `package.json` under `contributes.commands`; add to `contributes.menus["view/item/context"]` with matching `contextValue` if it's a tree action; register handler in `extension.ts`
4. **Tests** — `npm run test:unit` green; add command ID to `EXPECTED_COMMANDS`; `npm run test:integration` green

## Validation

Run `/validate` at the end of any task. It sequences all gates in order and tells you when to stop.

## Conventions

### Test-Driven Development
Always use `/tdd` when fixing bugs or developing new features.

### Logging Standards

**C# backend (Serilog, rolling file to `%LOCALAPPDATA%/mEdit/logs/`)**
- Every endpoint catch block must `_logger.LogError(ex, "...")` before returning `Results.Problem(ex.Message)`. Never return `ex.ToString()` (stack trace leak). Never return from catch without logging.
- Best-effort catches use `_logger.LogWarning` — no silent `catch { }`. Exception: per-call property accessor lambdas in `SchemaReflector` stay silent to avoid log noise.
- Use structured properties: `_logger.LogInformation("Indexed {Count} records for {Plugin}", n, name)`.
- `LogInformation` for state transitions. `LogDebug` for per-record/per-column trace.

**TypeScript extension**
- Single `vscode.OutputChannel` named `'mEdit'`, created in `extension.ts` and passed to every module making HTTP calls or handling async errors.
- All `catch` blocks log to OutputChannel before showing UI (`showErrorMessage`) or swallowing. No silent `catch { }`.
- `PluginTreeProvider` shows an error tree node instead of an empty list when a fetch fails.

**Webview**
- All async operations must check `resp.ok` and set error state on failure. Fire-and-forget fetches are not allowed.
