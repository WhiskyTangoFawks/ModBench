# mEdit

VS Code extension + local C# service for viewing, editing, and comparing Bethesda plugin files (`.esp`/`.esm`/`.esl`).

## Stack

**Backend** — C# ASP.NET Core minimal API (`MEditService/`)
- Mutagen: plugin parsing/writing
- DuckDB: in-process record index — indexed read model of committed (on-disk) record data
- Swashbuckle: OpenAPI spec auto-generation

**Frontend** — TypeScript VS Code extension + React webviews (`medit-vscode/`)
- API client generated from OpenAPI spec at build time
- `openapi-fetch` typed client — all HTTP calls through typed path strings, never raw `fetch()`

## Key Invariants

- Binary plugins = source of truth. DuckDB = indexed read model — only read path for queries; all record queries through `IRecordRepository`, not Mutagen. Staged changes buffered in separate table.
- Records table uses `(form_key, plugin)` composite key — one row per plugin that contains that FormKey
- DuckDB schema reflection-generated at startup from Mutagen types
- Backend and extension always started independently by the user
- Architecture must support all Mutagen-supported games without code changes; tests may use FO4 as concrete game

Rationale: [docs/adr/](docs/adr/). Frontend design: [docs/UI_SPEC.md](docs/UI_SPEC.md).

## References

`Mutagen/` — local clone for API reference only. Grep to verify type names, method signatures, interface hierarchies. Do not modify.

`TES5Edit/` — local clone (Pascal) for record/field definitions. `wbDefinitionsFO4.pas` for FO4 records; `wbArrayS` = sorted array, `wbArray` = unsorted. Do not modify.

Mutagen docs: start with `Mutagen/docs/Big-Cheat-Sheet.md`; full index at `Mutagen/docs/index.md`.

## Development Workflow

All commands from `medit-vscode/`. Pass `-v minimal` to `dotnet build` and `dotnet test` — only warnings and summary shown.

```bash
npm run test:unit        # Vitest unit tests (no backend required)
npm run test:integration # integration tests in real VS Code process (~10s, no backend required)
npm run build            # type-check + bundle extension + webview
npm run generate-api     # regenerate src/generated/api.ts from live backend at :5172 — commit alongside C# changes
```

## Adding a New Command (End-to-End)

1. **Backend** — add C# endpoint with `.Produces<T>()` and `.ProducesProblem(status)`; run `npm run generate-api`
2. **Frontend logic** — HTTP data access → `PluginRepository` (injectable, testable without VS Code); orchestration + side effects → `SessionController`
3. **VS Code wiring** — register in `package.json` under `contributes.commands`; add to `contributes.menus["view/item/context"]` with matching `contextValue` if tree action; register handler in `extension.ts`
4. **Tests** — `npm run test:unit` green; add command ID to `EXPECTED_COMMANDS`; `npm run test:integration` green

## Conventions

Run `/validate` at end of any task.

Always use `/tdd` when fixing bugs or developing new features.

Never add suppressions without user approval.

Solving pre-existing problems is always in scope.
