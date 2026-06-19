# TD-002 — saveAllGroups / revertAllGroups silently no-op on stale cache

## Problem

`mEdit.saveAllGroups` and `mEdit.revertAllGroups` commands get their group list from `changeGroupTreeProvider.getCachedGroups()`, which is only populated when VS Code calls `getChildren()` during tree rendering. `refresh()` fires an `_onDidChangeTreeData` event — it does not call `getChildren()` itself.

If the user invokes either command before the Change Groups tree panel has been rendered (e.g., via the command palette immediately after startup, or via a keybinding), `_groups` is `[]` and the operation silently does nothing — no error, no warning.

```typescript
// extension.ts
const groups = changeGroupTreeProvider.getCachedGroups().flatMap(g => g.id ? [{ id: g.id }] : []);
await controller.saveAllGroups(groups);  // groups is [] if tree never rendered
```

## When it triggers

- User invokes "Save All Groups" or "Revert All Groups" via command palette before opening the Change Groups sidebar panel
- Tree panel is in the sidebar but collapsed or scrolled out of view (VS Code may not call `getChildren()` until the view is expanded)
- A refresh was just triggered but `getChildren()` has not yet resolved (race window)

## Fix

Fetch the current group list directly from the backend instead of reading the render cache. Options:

1. Add `getGroups(): Promise<ChangeGroup[]>` to `ChangeGroupsTreeProvider` that calls `GET /change-groups` directly, bypassing `_groups`.
2. Move the group-list fetch into `SessionController.saveAllGroups`/`revertAllGroups` — they already have the client — and remove the `groups` parameter (controllers fetches its own list).
3. Have `extension.ts` call `GET /change-groups` directly and pass results to the controller, keeping concerns separated.

Option 2 is simplest and removes the awkward `{ id: string }[]` parameter that forces the caller to know the group shape.
