# Phase 11.3 — "Referenced By" Panel

**Status: Complete**

*Goal: surface reference data as a separate VS Code webview panel. Users can see every record that references the current FormKey, with click-to-open navigation. No tab bar inside the record editor — this is its own panel.*

*Depends on: Phase 11.2 (API endpoint + generated client).*

---

## Extension / Webview

### New webview panel — `ReferencedByPanel`

- [ ] Create `src/ReferencedByPanel.ts` — a new `vscode.WebviewPanel` type, separate from the record editor panel. Title: `"Referenced By: {EditorID}"` (or FormKey if no EditorID). Opens in `ViewColumn.Beside`.
- [ ] The panel's webview HTML shell uses the same `webviewHtml` helper as the record editor, but mounts a different React root — `ReferencedByApp` (see below).
- [ ] Pass `formKey` and `port` to the webview via `window.mEditFormKey` / `window.mEditBackendPort` globals, same pattern as the record editor.

### New React component — `webview/src/ReferencedByApp.tsx`

- [ ] Create `ReferencedByApp.tsx` — the React root for the Referenced By panel. Reads `mEditWindow.mEditFormKey` and `mEditWindow.mEditBackendPort`.
- [ ] On mount, call `GET /records/{formKey}/references` via `fetch` using `port`. Fetch is lazy by nature — the component only mounts when the panel is opened.
- [ ] States: `loading`, `loaded(results)`, `error`
- [ ] Loading state: muted "Loading…" text
- [ ] Error state: muted error message
- [ ] Empty state (`results.length === 0`): muted "No references found"
- [ ] Loaded state: group results by `formKey` before rendering. For each unique `formKey`:
  - **Group header**: expand/collapse toggle, `{recordType} / {editorId ?? formKey}`, and `(N plugins)` count when N > 1. Collapsed by default.
  - **Left-click on header**: send `{ type: WEBVIEW_TO_EXTENSION.OPEN_RECORD, formKey }` via `vscode.postMessage` — extension navigates the active record panel to that FormKey.
  - **Right-click on header**: browser context menu is suppressed; send `{ type: WEBVIEW_TO_EXTENSION.OPEN_RECORD_BESIDE, formKey }` — extension opens in a new panel (`ViewColumn.Beside`).
  - **Expanded child rows** (one per `ReferenceResult` in the group): plugin chip + muted monospace `fieldPath`. Not clickable.
- [ ] Use constants from `messages.ts` — not string literals. Add `OPEN_RECORD_BESIDE: 'openRecordBeside'` to `WEBVIEW_TO_EXTENSION` in `messages.ts`.

### Entry points — `src/extension.ts`

- [ ] Register `mEdit.showReferencedBy` command: takes a `formKey` + `editorId` (available from the tree node's `contextValue` metadata); creates a `ReferencedByPanel`.
- [ ] Add `"Show Referenced By"` to `contributes.menus["view/item/context"]` for `contextValue == "record"` in `package.json`.
- [ ] Handle `WEBVIEW_TO_EXTENSION.OPEN_RECORD` from `ReferencedByPanel` webview: call existing `openRecordPanel` logic with `ViewColumn.Active`.
- [ ] Handle `WEBVIEW_TO_EXTENSION.OPEN_RECORD_BESIDE` from `ReferencedByPanel` webview: call `openRecordPanel` with `ViewColumn.Beside`.

### `messages.ts`

- [ ] Add `OPEN_RECORD_BESIDE: 'openRecordBeside'` to `WEBVIEW_TO_EXTENSION`.

---

## Tests

New file `webview/src/ReferencedByApp.test.tsx`:

- [ ] **Test setup**: set `(window as any).mEditFormKey` and `(window as any).mEditBackendPort` in `beforeEach`.
- [ ] **Loading state**: mock `fetch` to return a pending promise; assert "Loading…" text is present.
- [ ] **Empty state**: mock `fetch` to return `[]`; assert "No references found" text.
- [ ] **Single-plugin group**: mock `fetch` with one `ReferenceResult`; assert one group header showing `{recordType} / {editorId}` with no count suffix; no child rows visible (collapsed by default).
- [ ] **Multi-plugin group**: mock `fetch` with two `ReferenceResult` entries sharing the same `formKey` but different `plugin` values; assert one group header with `(2 plugins)` count; expanding reveals two child rows each showing plugin name and `fieldPath`.
- [ ] **Two distinct groups**: mock `fetch` with two results with different `formKey` values; assert two separate group headers.
- [ ] **Left-click header sends OPEN_RECORD**: click a group header; assert `vscode.postMessage` called with `{ type: 'openRecord', formKey: <expected> }`.
- [ ] **Right-click header sends OPEN_RECORD_BESIDE**: right-click a group header; assert `vscode.postMessage` called with `{ type: 'openRecordBeside', formKey: <expected> }`.
- [ ] **Child rows are not clickable**: expanded child rows have no `onClick` handler.

`src/test/integration/extension.test.ts`:

- [ ] Add `mEdit.showReferencedBy` to `EXPECTED_COMMANDS`.

## Proof

*To be filled in on completion. Paste `npm run test:unit` output, `npm run test:integration` output, and commit hash here.*
