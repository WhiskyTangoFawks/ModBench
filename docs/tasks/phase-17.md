# Phase 17 — Record Editor Column Interactions

**Status: Not Started**

*Goal: the compare grid supports the column-level operations xEdit users expect — collapsing noisy columns, moving values between overrides, and acting on a whole override at once.*

## Webview
- [ ] Left-click on a plugin column header collapses that column to minimal width (just the plugin name chip); click again to expand; collapsed state persisted per record panel session
- [ ] Drag-drop of a field cell value between plugin columns: drops the source value as a pending field change into the target plugin's column; target must be an editable plugin; dragging from a read-only column is allowed (copy, not move)
- [ ] Visual drag affordance on cells in edit mode (cursor change, subtle grab handle)

## Extension / Webview
- [ ] Right-click on plugin column header in record editor context menu:
  - "Copy All to Pending" — copies every field value from this column into a pending change for the active editable plugin (equivalent to xEdit "copy as override" from the column header)
  - "Copy as New Record" — copies all field values as a new record pending change in the active editable plugin
  - "Remove Override" — stages a delete of this plugin's override of this record (delegates to Phase 10 delete; disabled for immutable plugins)

## Tests
- [ ] Webview: collapsed column stores state in component; re-click restores full width
- [ ] Webview: drag-drop from a source column stages the correct pending field change for the target plugin
- [ ] Webview: "Copy All to Pending" context menu action stages pending changes for all fields visible in the column

## Proof

*To be filled in on completion. Paste `dotnet test` output, `npm run test:unit` output, and commit hash here.*
