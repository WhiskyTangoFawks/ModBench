# Native tree drag/drop affordance (insertion indicator, cancel gesture)

Modbench does not customize the drag-over visual or add a cancel gesture to
`TreeView` drag and drop beyond what VS Code's native tree widget already
provides.

## Why this is out of scope

`vscode.TreeDragAndDropController`'s entire surface is `dropMimeTypes`,
`dragMimeTypes`, `handleDrag(source, dataTransfer, token)`, and
`handleDrop(target, dataTransfer, token)`. There is no property or method
that lets an extension choose, request, or style the drag-over visual —
that rendering belongs to the native tree widget, not the extension.

VS Code's tree already has two distinct native visual states for this —
`list.dropBackground` (drop onto) vs. `list.dropBetweenBackground` (drop
between rows) — chosen internally from cursor position within the row.
Modbench's draggable rows already declare `TreeItemCollapsibleState.None`
(no children possible), the correct signal for "insert" semantics; there is
no extension-side lever to force the between-rows indicator to show more
readily or to add a bespoke one.

Cancel-during-drag is the same shape of problem: `handleDrag`/`handleDrop`
each receive a `CancellationToken` documented as "indicating that
drag/drop has been cancelled." That token is the platform notifying the
extension a cancel already happened (e.g., Esc during an OS-level drag) —
it is not a capability the extension can add.

Building either of these would mean abandoning the native `TreeView` for a
custom-rendered one (e.g. a webview tree) just to control a highlight
color and a cancel gesture — which the project's native-first doctrine
(ADR-0027) rules out. A webview is justified by what it renders, never by
chrome around a native widget, and this is exactly the "reinvent what
VS Code already gives us for free" case that doctrine exists to prevent.

```ts
// vscode.d.ts — the complete customization surface, no visual/cancel hooks:
export interface TreeDragAndDropController<T> {
	readonly dropMimeTypes: readonly string[];
	readonly dragMimeTypes: readonly string[];
	handleDrag?(source: readonly T[], dataTransfer: DataTransfer, token: CancellationToken): Thenable<void> | void;
	handleDrop?(target: T | undefined, dataTransfer: DataTransfer, token: CancellationToken): Thenable<void> | void;
}
```

If a future VS Code release adds a customization hook for tree drag-over
visuals or programmatic drag cancellation, revisit this file.
