# Phase 10 — Design Todos

Issues to resolve before implementing Phase 10 sub-phases. Ordered by dependency: fix blockers in 10.1 and 10.2 before starting those phases; fix 10.3/10.4 issues after Phase 11 is wired; fix 10.5 before touching the frontend.

---

## 10.1 — PendingChange Model & ChangeGroup Infrastructure

- [x] **Place `GroupMember` in `Edits/`.** **Resolved:** Declare in `Edits/` alongside `PendingChange`. Used by both 10.3 and 10.4 so it must be a shared type, not file-scoped private.

- [x] **Specify `StageGroup` transaction boundary.** **Resolved:** Wrap both INSERTs (into `change_groups` then bulk into `pending_changes`) in a single DuckDB transaction, same pattern as existing `Upsert`. If the bulk insert fails, the `change_groups` row is rolled back atomically. The method inserts into `change_groups` then bulk-inserts member rows. If the bulk insert fails midway, the orphaned `change_groups` row must be rolled back. The plan doesn't say to wrap this in a DuckDB transaction. State explicitly: wrap both INSERTs in a single transaction, mirroring the pattern in `RevertGroup`.

- [x] **List all `GetChanges` call sites.** **Resolved:** One endpoint call site (`ChangeEndpoints.cs:51`) and five test call sites in `PendingChangeServiceTests.cs`. All use optional params with defaults — adding `Guid? groupId = null` is non-breaking. No surprises at compile time. Adding `Guid? groupId` is a breaking interface change. Before shipping 10.1, enumerate every caller in `ChangeEndpoints.cs` and in tests and note which ones need the default `null` added. Do this now so there are no surprise compile errors mid-phase.

- [x] **Assert single-group ownership invariant in `StageGroup`.** **Resolved:** Before inserting, call `GetGroupIdForRecord` for each member. If any member is already group-owned, throw `InvalidOperationException` — do not insert anything. `LIMIT 1` in the query is still present but the guard makes it a true invariant. 10.3 and 10.4 do not need to re-derive this. `GetGroupIdForRecord` uses `LIMIT 1` — silent if two groups somehow own the same `(formKey, plugin)`. `StageGroup` should check `GetGroupIdForRecord` for each member before inserting and throw if any member is already group-owned. Document this invariant so 10.3 and 10.4 don't need to re-derive it.

- [x] **Update 409 error message in the webview for `BlockedByGroup`.** **Resolved:** Confirmed `webview/src/RecordPanel.tsx:529` has hardcoded `'Plugin is read-only'` for any 409. Fix: read the problem detail body and distinguish the two cases — `PluginImmutable` shows "Plugin is read-only"; `BlockedByGroup` shows "This record has a pending group change — revert the group first." Added to the 10.1 frontend checklist. `RecordPanel.tsx:529` currently maps any 409 on PATCH to the hardcoded string "Plugin is read-only." Once 10.1 adds `BlockedByGroup`, a 409 can mean two different things. The frontend needs to read the problem detail body and show a distinct message (e.g., "This record has a pending group change — revert the group first"). Add this to the 10.1 frontend checklist.

---

## 10.2 — New Record Creation

- [x] **Fix wrong Mutagen API name: `NextObjectID` → `NextFormID`.** **Resolved:** Confirmed via `Mutagen/Mutagen.Bethesda.Core/Plugins/Records/IMod.cs:40` — the property is `NextFormID`. Phase-10.2.md updated.

- [x] **Design the `AddNew` group access problem.** **Resolved:** Add `Func<ISetter, FormKey, IMajorRecord>? AddNew` to `RecordTableSchema` (not `ColumnSpec` — this is per-type, not per-column). Built once at startup in `SchemaReflector.BuildSchema()` by reflecting on the game-specific mutable mod type to find the `IGroup<T>` property whose element type matches the current record type, then emitting a delegate `(mod, fk) => ((IGroup<T>)prop.GetValue(mod)!).AddNew(fk)`. `PluginWriter` calls `schema.AddNew!(mod, reservedFormKey)` to create a blank record; sibling `FieldEdit` changes are applied on top via `TryApplyField`. Template-based creation is the same path — blank record plus copied field edits. See phase-10.2.md for implementation checklist.

- [x] **Resolve UI entry point conflict: plugin node vs. record type node.** **Resolved:** Plugin node. User right-clicks a plugin, QuickPick lists all record types, plugin is already known from context. Matches UI_SPEC section 2.2. Phase-10.2.md updated. [UI_SPEC.md section 2.2](../UI_SPEC.md) shows "Add New Record…" on the **plugin** node context menu (user then picks the record type in a follow-up quick-pick). Phase 10.2 puts `mEdit.createBlankRecord` on the **record type** node (`viewItem == recordType`). These produce different UX flows. Pick one and update both the phase doc and the UI_SPEC:
  - Plugin node: user picks record type from a list, then the plugin is already known from context.
  - Record type node: record type is already known, user picks which mutable plugin to add to.
  The second is simpler to implement; the first matches the spec. Whichever is chosen, update both documents.

- [x] **Document the `copy-to` removal migration.** **Resolved:** `POST /records/{formKey}/copy-to/{targetPlugin}` is removed in Phase 10.2. Backend and extension must be updated together — an older extension against a newer backend (or vice versa) will get 404 on copy-to. Note added to phase-10.2.md. Removing `POST /records/{formKey}/copy-to/{targetPlugin}` is a live break for any open VS Code window with an older extension. The release notes for this phase should state that backend and extension must be updated together. Add a note to the phase.

---

## 10.3 — Delete Records

- [x] **Use `GetReferences()` for nullification, not raw `form_references`.** **Resolved:** Step 4 of the orchestrator must call `_repository.GetReferences(formKey)` for each deleted record, not query `form_references` directly. `GetReferences` unions committed + pending state (Phase 11.2), so pending `FieldEdit` changes pointing to the deleted record are correctly included in the nullification set. Phase-10.3.md updated. Step 4 in the orchestrator logic queries `form_references WHERE target_form_key IN (…)` directly to find FormLink fields to nullify. But `form_references` only reflects committed state. A pending `FieldEdit` that points to the record being deleted will be missed. Replace this with `GetReferences(formKey)` for each deleted record — that method already unions committed + pending (from Phase 11.2).

- [x] **Specify the confirmation UX.** **Resolved:** Use `vscode.window.showWarningMessage` with "Delete" / "Cancel". Show the N record labels (`EditorID [RecordType:FormID]`). No pre-flight reference count — the dialog is a "are you sure?" gate, not a full impact preview; that's the Referenced By panel's job. Multi-select (ctrl+click / shift+click) across plugins is supported; Delete key also triggers the command. Phase-10.3.md and UI_SPEC updated.

- [x] **Document `BlockedByGroup` in the result type definition.** **Resolved:** Added `BlockedByGroup` case to `DeleteRecordsResult` in phase-10.3.md: "One or more records in the batch already has a pending group change; revert that group before deleting." The orchestrator logic references `DeleteRecordsResult.BlockedByGroup` but the result type section only defines `Staged` and `Blocked`. Add the `BlockedByGroup` case with a description: "One or more records in the batch already has a pending group change; revert that group before deleting."

---

## 10.4 — Renumber FormID

- [x] **Fix wrong Mutagen API: use `DuplicateIntoAsNewRecord`, not `sourceRecord.Duplicate()`.** **Resolved:** Confirmed via `Mutagen/Mutagen.Bethesda.Core/Plugins/Cache/ModContext.cs:190` — use `context.DuplicateIntoAsNewRecord(mod, newFormKey)`. Phase-10.4.md updated. The plan says "call `sourceRecord.Duplicate(newFormKey)`." Bare `IMajorRecord.Duplicate()` doesn't add the record to any group. The correct API (see `ModContext.cs:190` and `ModCompactor.cs:203`) is `context.DuplicateIntoAsNewRecord(mod, newFormKey)` — operating on a `ModContext` obtained from the link cache. Update the `PluginWriter` renumber path to use the context-based approach.

- [x] **Clarify intra-plugin vs. cross-plugin cascade split.** **Resolved:** Stage `FieldEdit` changes only for references in *other* editable plugins. `RemapLinks` handles all references within the plugin being saved. Phase-10.4.md updated with explicit note. The plan stages `FieldEdit` changes for references in editable plugins AND calls `mod.RemapLinks()` at save time. A reference in the *same* plugin as the renamed record is caught by both, causing a double-update. The save path should stage `FieldEdit` changes only for *other* plugins; `RemapLinks` handles all references within the plugin being saved. State this split explicitly in the orchestrator logic and in the `PluginWriter` renumber section.

- [x] **Write a visual spec for the FormID rename UI in the record panel.** **Resolved:** In edit mode, the FormID hex portion in the panel header becomes a 6-char hex `<input>`. The `:{OriginPlugin}` suffix stays fixed beside it. "Renumber" button disabled until value differs; disabled entirely on immutable plugins. 422 → inline error below input; 409 → notification listing blocking plugins. UI_SPEC section 3.1 updated. The plan says "FormID display becomes an editable field in edit mode; 'Renumber' button stages the group." The current panel header is a plain title string — nothing in `RecordPanel.tsx` supports this. Specify before implementing:
  - Where the FormID appears (below the EditorID title? inline?)
  - Whether it's always visible or only in edit mode
  - Input widget: `<input type="text">` constrained to hex? Or `<input type="number">`?
  - "Renumber" button placement and disabled state
  - Error display when the new FormID is already in use (422 response)
  
  Add this to [UI_SPEC.md section 3.1](../UI_SPEC.md) (Panel Header).

---

## 10.5 — Group Save Path

- [x] **Design the ChangeGroup UI before writing any code.** **Resolved:** Second VS Code tree view (`mEditChangeGroups`) in the mEdit view container. Title bar: "Save All" / "Revert All" buttons (hidden when empty). Each group row: `{operation} — {description}` with `{N} changes · {P} plugins` detail, inline Save / Revert buttons. Empty state: "No pending group changes." Group rows not expandable in Phase 10.5. UI_SPEC section 4 written. Phase-10.5.md updated. [UI_SPEC.md section 4](../UI_SPEC.md) is explicitly marked "Design not yet finalized." Phase 10.5 is entirely blocked on this. Fill in section 4 with:
  - **Where it lives:** sidebar panel? A second tab in the record editor? A dedicated webview? A bottom-panel-style section below the compare table?
  - **What each group row shows:** operation label, description (if any), change count, affected plugins
  - **Action buttons:** "Save" and "Revert" — their placement, disabled states (e.g., saving in progress), and confirmation behavior for Revert
  - **Empty state:** what the user sees when no groups are in flight
  - **Error state:** what happens if `saveGroup` returns a partial failure

- [x] **Acknowledge and document the partial-save failure case.** **Resolved:** If Plugin A saves but Plugin B throws: Plugin A's binary is already updated on disk; all drained changes are re-queued with `group_id` intact. The re-queued changes for Plugin A will be a no-op on the next save if values already match. The frontend shows an error notification distinguishing which plugins saved and which failed. Documented in phase-10.5.md and UI_SPEC section 4.4. If Plugin A in a group saves successfully but Plugin B throws, the catch block re-queues all changes — but Plugin A's binary is already updated on disk. The re-queued changes for Plugin A are now inconsistent with the on-disk and index state. There's no clean solution without two-phase-commit. Document the actual behavior: "Plugin A's changes are committed to disk; Plugin B failed. The re-queued changes for Plugin A will be re-applied on the next save of Plugin A, which may be a no-op if the values match." Show the user a clear error distinguishing which plugins saved and which failed.

- [x] **Add per-plugin change filtering to `SaveGroup`.** **Resolved:** After `DrainGroup()`, group by plugin: `var byPlugin = drained.GroupBy(c => c.Plugin)`, then call `SavePlugin(plugin, byPlugin[plugin])` for each. Documented in phase-10.5.md implementation steps. The plan says "for each affected plugin, call the existing `SavePlugin()` logic" but `SavePlugin(plugin, changes)` takes a plugin-scoped list. After `DrainGroup()`, you have a flat list across all plugins. Add an explicit step: `var byPlugin = drained.GroupBy(c => c.Plugin)`, then call `SavePlugin(plugin, byPlugin[plugin])` for each. State this in the implementation steps.
