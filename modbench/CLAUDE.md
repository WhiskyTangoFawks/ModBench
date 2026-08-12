# modbench

TypeScript VS Code extension. Root [CLAUDE.md](../CLAUDE.md) for project-wide invariants.

## Invariants

- VS Code workspace root = MO2 instance dir. `src/modmanager/` reads `mods/`, `profiles/`, `ModOrganizer.ini` relative to it — no separate instance-path config. `ModOrganizer.ini` supplies `selected_profile`/`gamePath`. `GamePathDetector` resolves only the vanilla/editing game path (later phases), not the instance.
- Mod-manager writes are byte-faithful surgical edits, never model→re-serialization — splice only changed bytes of `modlist.txt`/`ModOrganizer.ini` (CRLF, comments, `*` lines, separators, order survive verbatim). Pure transforms: `src/modmanager/mo2/*.ts`. In-memory `ModlistEntry[]` = read-view, not the serialization source.
- All backend HTTP calls go through the generated `openapi-fetch` client (`ApiClient`) — never raw `fetch()`.
- Don't rebuild what VS Code already does — check native capability first, **and the rule does not stop at the webview boundary**. Extension-side: file mgmt → Explorer (`revealInExplorer`), not a bespoke browser; row coloring → `FileDecorationProvider`, not a custom widget. Webview-side: right-click menu → `contributes.menus["webview/context"]` + `data-vscode-context`, not a rendered `<ul role="menu">`; pick-one-of-N → `showQuickPick`/`createQuickPick`, not a rendered dropdown; confirm-destructive → `showWarningMessage(…, { modal: true })`, not a rendered overlay; free text in → `showInputBox`; get text *out* of a **tree or list** → a **Copy command**, never a bespoke selection mechanism (what Explorer/Problems/SCM/Debug-Variables all do — those surfaces have no text selection at all, so a command is the only answer); a hierarchy → `TreeView`, not rendered chevrons. **Get text out of a webview → `Ctrl+C` on the focused cell**, which reads the cell's model value directly rather than going through DOM/native text selection — the record editor's answer per [ADR-0034](../docs/adr/0034-xedit-is-the-ux-reference-for-the-record-editor.md): click focuses a cell, it does not select text, so copy cannot depend on a text selection existing. Corollary: because copy reads the model value and not the rendered label, a lossy label (`{…}`, `[3]`) no longer blocks copying — but still fix the label, since it's what the user reads even after it stops being what they copy. Work within the native widget's limits (e.g. no per-row bg color in a TreeView) rather than reinvent them. A webview is justified by what it *renders* — the compare grid, which nothing native provides — never by the chrome around it. Ask "which VS Code surface already does this?" before designing any interaction; if the answer is a surface, copy its answer. Not `@vscode/webview-ui-toolkit` — archived; the native path is contributions + commands. [ADR-0027](../docs/adr/0027-mo2-surfaces-map-to-native-vscode-views.md)
- Prefer reactive updates over manual refresh — watch the source (`createFileSystemWatcher`) and re-render; don't require a Refresh click. Manual Refresh, if present, is only a safety net for flaky watch events, never the primary path.
- **Where a command lands in a title bar is decided by rule, not per ticket** ([#247](https://github.com/WhiskyTangoFawks/ModBench/issues/247)). The Native-first rule above answers *which surface* an interaction uses; this answers *where on it*. Five title bars each invented their own answer under time pressure from their own slice, which is how one view reached nine icons while another routed a comparable action to overflow.
  1. **Scope first.** If an action isn't about this tree's own domain, it doesn't go on this tree — it goes to the **Loadout header view** (`modbench.loadoutHeader`, [docs/specs/loadout-header.md](../docs/specs/loadout-header.md)), the status bar, or the palette. Roughly half the icons the trees had grown were workspace-scope: profile, session, deployment, refresh. VS Code's container-level `…` is *its own* auto-generated Views menu and is not a contribution point, so a real view is the only shared home.
  2. **Four navigation icons maximum.** Not taste: VS Code collapses navigation icons into `…` when a view is narrow, so a fifth is already unreliable. A two-command context-key toggle counts as one — only ever one of the pair is visible.
  3. **An icon is earned** by in-workflow frequency (used more than once per session) or by being a state readout (sort direction, show-hidden, filter-active). Configure-once and occasional actions go to `…`.
  4. **Destructive actions never get an icon** — overflow plus a modal confirm (`showWarningMessage(…, { modal: true })`).
  5. **Fixed slot order**, so an icon means the same thing in every view: name filter, then the view's state affordance (presentation toggle, or a second narrowing axis like the record filter), then domain actions, then overflow, then Collapse All (native, always last). Assign `navigation@1`… in that order **skipping what a view doesn't have** — Pending Changes has no filter, so Save All is its `@1`; the header is not a list, so Refresh is its `@1` and Launch… its `@2`. What the rule fixes is the *order*, not the number.
  6. **Icon vocabulary:** `$(search)` = narrow by name, `$(filter)` = narrow by condition, `$(refresh)` = re-read from disk and is **one command id** (`modbench.refresh`) covering every Mod-Management source at once.
  7. **`showCollapseAll` on every hierarchical tree, never on a flat list.** Currently: Mods, the editing Plugins tree, Pending Changes — yes; Plugin List, Downloads, the header — no.
  8. **Session reload is not Refresh.** It costs seconds and can disturb staged work, so it stays a separate, explicitly-named command in overflow.

  Filtering is **one widget** (`registerFilterBoxCommand`) used by every list view — Mods, Plugin List, Plugins tree, Downloads. Adding a fifth list view means reusing it, not writing a second one. The rules govern the *surface*, not command ids: several ids still carry a `modList.` prefix from where they used to live, and renaming them would be churn with no user-visible effect.

  Rules 1–6 and 8 are enforced in `src/test/packageJson.test.ts`, not by review — a new contribution that breaks one fails there. **Rule 7 is not**: `showCollapseAll` is a `createTreeView` option with no declarative contribution and no readable property on the returned `TreeView`, so it has no test seam and is checked by reading the call sites in `extension.ts`.

## Module Map

| Module | Owns | Key rule |
| ------ | ---- | ---- |
| `extension.ts` | Wiring: instances, commands, prompts | No business logic; prompts then delegates to `SessionController` |
| `SessionController` | HTTP orchestration (create plugin, copy record, load session) | No VS Code types in interface — MCP tools call it directly |
| `SessionWizard` | Multi-step session setup (game path detect → `POST /session/load`) | Returns `boolean`: session now loaded |
| `BackendManager` | Backend lifecycle: `start()` (attach if healthy, else spawn bundled binary), `stop()`, crash-restart; polls `GET /health` | Spawns/tears down backend ([ADR-0022](../docs/adr/0022-extension-owns-backend-lifecycle.md)); path/exe injected by `extension.ts` |
| `PluginRepository` | HTTP adapter (`GET /plugins`, `/record-types`, `/records`) | Interface `PluginRepository`; impl `ApiPluginRepository` |
| `PluginTreeProvider` | Sidebar tree: repo data → tree nodes; page cache | Takes `PluginRepository`, not `ApiClient` — cache keyed `"plugin::recordType"` |
| `ApiClient` | Typed `openapi-fetch` client factory | Type alias for generated client; DTOs defined here |
| `GamePathDetector` | Game path discovery (Steam VDF / Windows registry) | Pure utility; returns `GamePaths \| null` |
| `webviewHtml` | HTML shell for record editor webview | No VS Code types except `Uri` string |
| `recordPanelMessageRouter` | Webview→extension message dispatch for the record panel | Pure function, no VS Code types in signature except injected deps — testable without a harness |
| `LoadoutHeaderProvider` | The Loadout header's rows: profile, editing session, deployment ([docs/specs/loadout-header.md](../docs/specs/loadout-header.md)) | Composition root, imports from neither bounded context — all state injected as getters, so it is unit-testable without a VS Code harness. Renders nothing when there is no loadout: its rows' commands only exist alongside the Loadout views |
| `reporter` | ADR-0026 surfacing reporter (`makeReporter`): logs at the level matching severity, toasts on warning/error | Takes the leveled channel directly (`.warn`/`.error`), not the flat `log` shim — testable without a harness (`vi.mock('vscode')`) |
| `backendLog` | `makeBackendLogForwarder`: one line of backend console output → the matching leveled channel call. `backendLogLevelArgs`: the channel's level → the backend's Serilog spawn-arg override | Sole owner of Serilog-console-format knowledge, both directions — read (console template parsing) and write (`--Serilog:MinimumLevel:Default` argv, #205). Parse is tolerant — an untagged line is still forwarded, never dropped. Carried level is per stream (untagged stdout = continuation, untagged stderr = runtime crash → `error`) |

Placement:

- Context menu availability = tree node `contextValue` (from backend metadata): `"plugin"`, `"pluginImmutable"`, `"recordType"`, `"record"`.
- New commands: prompt in `extension.ts`, delegate to `SessionController` (explicit args, no VS Code types).
- New data queries: add to `PluginRepository` interface, implement in `ApiPluginRepository`, test without VS Code.
- New UI surface: read the surface spec in `docs/specs/` first — one spec per surface (`medit-plugins-tree.md`, `medit-record-editor.md`, `medit-pending-changes-tree.md`, `medit-referenced-by.md` for Editing, with `medit.md` the cross-cutting overview; `mods.md`, `plugins.md`, `downloads.md` for Loadout; `loadout-header.md` for the cross-context header). Update the spec if not covered.

## Type mapping: PluginMetadata

`PluginMetadata` (`ApiClient.ts`) = canonical frontend type, not generated `PluginResponse`. `ApiPluginRepository.getPlugins()` maps via `toPluginMetadata()` in `PluginRepository.ts`.

Adding a field to `PluginResponse`: C# model → `generate-api` → `PluginMetadata` in `ApiClient.ts` → `toPluginMetadata()`.

## Integration tests (`src/test/integration/extension.test.ts`)

Real VS Code process via `@vscode/test-cli` against a mock HTTP server (port 15172) — no real backend needed.

Update when: new command (add ID to `EXPECTED_COMMANDS`) or new `extension.ts` behavior. Skip for `SessionController`/`PluginRepository`/`BackendManager`/`PluginTreeProvider` — unit-tested without VS Code.

## Logging

- One `vscode.LogOutputChannel` (`'Modbench'`, created with `{ log: true }` — issue #198), created in `extension.ts`. Its native `.debug/.info/.warn/.error` methods drive the Output panel's level filter and stamp timestamps automatically.
- Call sites local to `extension.ts` call the channel's leveled methods directly (DEBUG/INFO for routine actions, WARN when the system correctly refuses something, ERROR for an actual failure). Other modules doing HTTP/async-error handling (`BackendManager`, `PluginRepository`, `SessionController`, etc.) still take a flat `log: (msg: string) => void` compat shim — their own releveling is tracked separately, not yet done.
- The spawned backend's Serilog console output is piped (`stdio: ['ignore','pipe','pipe']`) and forwarded line-by-line into the same channel, prefixed `[backend]`, at its parsed level (issue #199) — so the level filter governs backend and frontend lines alike. Only for a backend *we spawn*: an attached dev-launched one keeps logging to its own terminal. Streams are drained unconditionally — an unread pipe blocks the backend's writes.
- Every `catch` logs to the channel before showing UI or swallowing. No silent `catch {}`.
- `PluginTreeProvider`/`ModListProvider`: error tree node instead of empty list on fetch/read failure. `ModListProvider`'s status-badge calc (secondary, non-blocking) degrades badges + warns instead — silently-absent badges would look like "no conflicts."
- Webview: every async op checks `resp.ok`, sets error state on failure. No fire-and-forget fetches.

## Error surfacing ([ADR-0026](../docs/adr/0026-error-surfacing-policy.md))

User's mental model must never be silently wrong — missing/incomplete data the UI implies present needs a mandatory notification, even on HTTP-200 "success" (e.g. skipped plugin). Surface by severity, never a blanket popup:

| Severity | Response |
| --- | --- |
| Integrity / silent-wrong-state (skipped plugin, partial save, failed reindex) | notification (warn/error) + log, always |
| Explicit action failed (a command the user ran) | error notification + log |
| Background / recoverable / frequent (tree fetch blip, poll) | inline UI (error tree node, status bar) + log — not a toast |

Surface via an injected reporter (logs to channel, shows severity-appropriate surface) — no raw `vscode.window.*` in `SessionController`/repositories; keeps it testable (`SessionWizard` skipped-plugin tests). Backend returns structured failures (e.g. `SessionLoadResponse.Failures`); frontend decides surfacing — backend never swallows a partial outcome.
