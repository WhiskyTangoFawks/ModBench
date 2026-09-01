# modbench

TypeScript VS Code extension. Root [CLAUDE.md](../CLAUDE.md) for project-wide invariants.

## Invariants

- VS Code workspace root = MO2 instance dir; `ModOrganizer.ini` supplies
  `selected_profile`/`gamePath` ([docs/specs/mods.md](../docs/specs/mods.md)). No separate
  instance-path config.
- Mod-manager writes are byte-faithful surgical edits, never model→re-serialization
  (ADR-0021); in-memory `ModlistEntry[]` is a read-view, not the serialization source.
- All backend HTTP goes through the generated `openapi-fetch` client (`ApiClient`) — never raw
  `fetch()`.
- Prefer reactive updates (`createFileSystemWatcher` → re-render) over manual Refresh; Refresh is
  a safety net, never the primary path.
- Bounded-context import and vocabulary boundaries are pinned in
  `src/test/contextBoundary.test.ts`; title-bar placement rules and rationale in
  `src/test/packageJson.test.ts` — read the test before placing a command. The one untestable
  rule: `showCollapseAll` on every hierarchical tree, never a flat list — a `createTreeView`
  option with no test seam; check the call sites.
- `EditingController` keeps VS Code types out of its interface — chat tool handlers call it
  directly (ADR-0012).

## Placement

- New commands: register in the surface file for the command's own context; `extension.ts` only
  when it genuinely joins both. A forward-context-to-panel command is a
  `recordPanelForwarderCommands.ts` row.
- Context-menu availability = tree node `contextValue` — plugin rows carry Mod Management's
  values, expanded rows carry the record browser's (from backend metadata). Read-only-for-editing
  is a tooltip, never a contextValue (ADR-0035).
- New data queries: `PluginRepository` interface → `ApiPluginRepository`, tested without VS Code.
- New UI surface: read its spec in `docs/specs/` first (one spec per surface); update the spec if
  not covered.

## Wire types

**The generated schema is the frontend type — never mirror a wire DTO by hand.** `ApiClient.ts`
and `webview/src/types.ts` name `components['schemas'][…]` aliases; adding a wire field is C#
model → `/regenerate-api`, nothing else. The schema reports C# nullability and enums honestly
(pinned by backend `SwaggerSchemaTests` and `webview/src/types.test.ts`), so a `??` default or
trust-cast on a wire field is a bug, not defensive coding. Never edit `src/medit/generated/api.ts`
or read it to learn the wire shape — consult the C# DTOs (`MEditService.Core/Queries/Models.cs`).
Hand-written types earn their place only as a genuine transform or refinement of the wire type;
optionality that exists so stale fixtures compile is neither.

## Surfacing

Sites that log **and** toast go through the injected reporter (`makeReporter`); the severity table
and the no-raw-`vscode.window.*`-in-controllers rule are ADR-0026. Log-only sites call the shared
`LogOutputChannel`'s leveled methods directly.
