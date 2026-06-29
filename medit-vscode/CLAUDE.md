# medit-vscode

TypeScript VS Code extension. Root [CLAUDE.md](../CLAUDE.md) for project-wide invariants.

`extension.ts` = composition root — wires everything, no business logic.

## Invariants

- **The open VS Code workspace root _is_ the MO2 instance directory.** The mod manager (`src/modmanager/`) reads `mods/`, `profiles/`, and `ModOrganizer.ini` relative to the workspace folder — there is no separate "instance path" config. `ModOrganizer.ini` supplies the active profile (`selected_profile`) and the game directory (`gamePath`). `GamePathDetector` resolves the _vanilla/editing_ game path only (later phases); it does **not** locate the instance.
- **Mod-manager file writes are byte-faithful via surgical edits**, never model→re-serialization: splice only the changed bytes of `modlist.txt`/`ModOrganizer.ini` so CRLF, comments, `*` unmanaged lines, separators, and order survive verbatim. Pure transforms live in `src/modmanager/mo2/*.ts`; the in-memory `ModlistEntry[]` model is a read-view, not the serialization source.

## Module Map

| Module | Owns | Key rule |
| ------ | ---- | -------- |
| `extension.ts` | Wiring: creates instances, registers commands, handles prompts | No business logic; prompts user then delegates to `SessionController` |
| `SessionController` | HTTP orchestration for commands (create plugin, copy record, load session) | No VS Code types in interface — MCP tools can call it directly |
| `SessionWizard` | Multi-step session setup (game path detection → `POST /session/load`) | Returns `boolean` — true if session now loaded |
| `BackendManager` | Polls `GET /health` until backend available; emits `'attached'` or `'disconnected'` | Never spawns backend process |
| `PluginRepository` | HTTP adapter for plugin/record data (`GET /plugins`, `/record-types`, `/records`) | Interface: `PluginRepository`; impl: `ApiPluginRepository` |
| `PluginTreeProvider` | VS Code sidebar tree: maps repo data to tree nodes; owns page cache | Takes `PluginRepository`, not `ApiClient` — page cache keyed on `"plugin::recordType"` strings |
| `ApiClient` | Typed `openapi-fetch` client factory | Type alias for generated client; DTOs defined here |
| `GamePathDetector` | Platform-specific game path discovery (Steam VDF / Windows registry) | Pure utility; returns `GamePaths \| null` |
| `webviewHtml` | Generates HTML shell for record editor webview panel | No VS Code types except `Uri` string |

**Placement rules:**

- Context menu availability controlled by tree node `contextValue` (set from backend metadata). Values: `"plugin"`, `"pluginImmutable"`, `"recordType"`, `"record"`.
- New commands: prompt in `extension.ts`, delegate to `SessionController` (explicit args, no VS Code types).
- New data queries: add to `PluginRepository` interface, implement in `ApiPluginRepository`, test without VS Code.
- Before any new UI surface: read `docs/UI_SPEC.md` first; add to spec if not covered.

## Type Mapping: PluginMetadata

`PluginMetadata` (in `ApiClient.ts`) = canonical frontend type, not generated `PluginResponse`. `ApiPluginRepository.getPlugins()` maps via `toPluginMetadata()` in `PluginRepository.ts`.

Adding a field to `PluginResponse`: C# model → `generate-api` → `PluginMetadata` in `ApiClient.ts` → `toPluginMetadata()`.

## Integration Tests (`src/test/integration/extension.test.ts`)

Real VS Code process via `@vscode/test-cli` against mock HTTP server (port 15172) — no real backend needed.

Update when: adding a command (add ID to `EXPECTED_COMMANDS`), or new `extension.ts` behavior. Don't add integration tests for `SessionController`, `PluginRepository`, `BackendManager`, `PluginTreeProvider` — unit-tested without VS Code.

## Logging

- Single `vscode.OutputChannel` named `'mEdit'`, created in `extension.ts`, passed to every module making HTTP calls or handling async errors.
- All `catch` blocks log to OutputChannel before showing UI or swallowing. No silent `catch { }`.
- `PluginTreeProvider` shows error tree node instead of empty list when fetch fails.
- Webview: all async ops must check `resp.ok` and set error state on failure. No fire-and-forget fetches.

## Error surfacing ([ADR-0026](../docs/adr/0026-error-surfacing-policy.md))

Principle: **the user's mental model must never be silently wrong.** Missing/incomplete data the UI implies is present is a mandatory notification — even on an HTTP-200 "success" (e.g. a skipped plugin). Surface by severity tier, never blanket-popup:

- **Integrity / silent-wrong-state** (skipped plugin, partial save, failed reindex) → notification (warn/error) **+** output log. Always.
- **Explicit action failed** (a command the user ran) → error notification + log.
- **Background / recoverable / frequent** (tree fetch blip, poll) → inline UI (error tree node, status bar) + log, *not* a toast.

Surface via an **injected reporter** dep (logs detail to the channel, shows the surface for the severity) — no raw `vscode.window.*` in `SessionController`/repositories; keeps it testable like the `SessionWizard` skipped-plugin tests. Backend returns **structured failures** (named record, e.g. `SessionLoadResponse.Failures`); the frontend decides how to surface — backend never swallows a partial outcome.
