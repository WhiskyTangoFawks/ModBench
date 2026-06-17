# TD-005: Command Handlers Carry Domain Logic, Bypassing the Read/Mutation Seam

**Severity:** Low
**Area:** `extension.ts` command handlers / `SessionController` / `PluginRepository`
**Introduced:** incremental, as commands were added directly in `extension.ts`

## What's happening

CLAUDE.md sets a clear seam: **data reads → `PluginRepository`, mutations → `SessionController`.**
Several command handlers in `extension.ts` bypass it and hold domain logic inline.

`mEdit.copyAsOverrideInto`
([extension.ts:165–199](../../medit-vscode/src/extension.ts#L165-L199)) fetches all plugins, then
applies the domain rule for which plugins can receive an override:

```ts
allPlugins = await controller.getPlugins();          // read via controller, not repository
const mutablePlugins = allPlugins.filter(p => !p.isImmutable);   // domain rule in a UI handler
```

"A record can only be copied as an override into a non-immutable plugin" is a domain fact (see
CONTEXT.md *Immutable plugin*). It lives in a QuickPick command handler, alongside UI construction.

The seam is further blurred in `SessionController` itself:

- `getPlugins()` ([SessionController.ts:23](../../medit-vscode/src/SessionController.ts#L23)) is a
  **read**, but lives on the mutation-side controller and calls the HTTP client directly rather than
  delegating to `PluginRepository.getPlugins()`.
- `repository` is typed **optional** (`repository?: PluginRepository`, line 7) yet used as required
  via non-null assertions: `this.deps.repository!.setFilter(sql)` (line 61), `.clearFilter()`
  (line 72), `.getActiveFilter()` (line 78). The type says "may be absent"; the code says "must be
  present."

## Impact

- **Domain rule stranded in UI.** The "editable plugin" filter can't be unit-tested without driving
  `vscode.window.showQuickPick`; if a second caller needs the same filter, the rule gets copied.
- **Seam says one thing, code does another.** New contributors can't trust "reads go through
  `PluginRepository`" because `getPlugins` doesn't.
- **`repository!` hides a latent crash.** If a `SessionController` is ever constructed without a
  repository (the type permits it), filter operations throw at runtime instead of failing to
  compile.

## Fix Plan

1. **Name the domain read.** Add `PluginRepository.editablePlugins()` (or `getPlugins()` plus a
   well-named filter helper) that returns non-immutable plugins. The `copyAsOverrideInto` handler
   calls it and only builds the picker:

   ```ts
   const targets = await repository.editablePlugins();
   const picked = await vscode.window.showQuickPick(targets.map(...));
   if (picked) await controller.copyRecordTo(formKey, picked.label);
   ```
2. **Route reads through the repository.** Have `SessionController.getPlugins()` delegate to
   `repository.getPlugins()` (or move read call sites off the controller entirely), so the
   documented seam holds.
3. **Make `repository` required.** Drop `?` and the `!` assertions in `SessionControllerDeps` —
   the controller genuinely depends on it.

## Decisions to make before implementing

1. **Does `getPlugins` belong on `SessionController` at all?** It's a read. Options: (a) delegate to
   repository but keep the method for callers' convenience; (b) remove it and have callers use
   `repository.getPlugins()` directly. Affects `onBackendConnected`
   ([SessionController.ts:107](../../medit-vscode/src/SessionController.ts#L107)), which reads plugin
   count to drive a status message.
2. **`editablePlugins()` naming** — fold the immutability rule into a named repository read, or
   expose a generic `getPlugins()` and keep `.filter(!isImmutable)` at call sites? Naming it once is
   the deeper fix; confirm no caller wants immutable plugins included.
3. **Scope.** This is the smallest of the five and overlaps no ADR. Could be folded into a general
   `extension.ts` command-extraction pass (the file is also a composition-root/god-file) rather than
   done in isolation.

## Related

- [extension.ts:165–199](../../medit-vscode/src/extension.ts#L165-L199) — `copyAsOverrideInto`
- [SessionController.ts:5–80](../../medit-vscode/src/SessionController.ts#L5-L80) — optional `repository`, `getPlugins`
- [PluginRepository.ts](../../medit-vscode/src/PluginRepository.ts) — read seam
- CLAUDE.md — "data reads → `PluginRepository`; mutations → `SessionController`"
- CONTEXT.md — *Immutable plugin*
