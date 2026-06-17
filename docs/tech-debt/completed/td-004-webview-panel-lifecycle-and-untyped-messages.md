# TD-004: Duplicated Webview Panel Lifecycle and Untyped Extension↔Webview Protocol

**Severity:** Low–Medium
**Area:** `extension.ts` (`openRecordPanel`) / `ReferencedByPanel.ts` / `messages.ts` / `webviewHtml.ts`
**Introduced:** incremental, as the second webview panel (Referenced By) was added

## What's happening

Two problems, same seam.

### 1. Panel lifecycle is hand-rolled twice

`openRecordPanel`
([extension.ts:232–281](../../medit-vscode/src/extension.ts#L232-L281)) and
`openReferencedByPanel`
([ReferencedByPanel.ts](../../medit-vscode/src/ReferencedByPanel.ts)) are near-identical: build a
cache key, check `openPanels` and `reveal()` if present, `createWebviewPanel`, register in the map,
`onDidDispose(() => openPanels.delete(key))`, wire `onDidReceiveMessage`, set `.html` from
`buildWebviewHtml`. The only real differences are the view-type string, the cache-key prefix, and
which script asset loads.

### 2. The message protocol is untyped string assertions

`messages.ts` defines bare string constants and **no payload types**:

```ts
export const WEBVIEW_TO_EXTENSION = {
  OPEN_RECORD: 'openRecord',
  OPEN_RECORD_BESIDE: 'openRecordBeside',
} as const;
```

Both handlers receive `msg: unknown` and cast:

```ts
// ReferencedByPanel.ts
const m = msg as { type: string; formKey?: string };
// extension.ts:264
const m = msg as { type: string; formKey?: string; label?: string };
```

The shape a webview must send (`{ type, formKey, label? }`) lives only in these casts. A renamed or
mistyped message field fails silently at runtime — there is no compile-time link between the
extension side and the React webview side that sends the message.

Cache keys are also string-concatenated (`__referenced_by__:${formKey}`,
`RECORD_PANEL_KEY`) — a FormKey containing the delimiter could collide, though in practice FormKeys
are well-formed.

## Impact

- **Two lifecycles to keep in sync.** A fix to disposal, reveal, or CSP handling must be applied in
  both places or they drift.
- **No type safety across the most fragile seam.** Extension and webview communicate by convention;
  a protocol change is caught only by manual testing, not the type-checker or `npm run build`.
- **Adding a third panel** (likely, as the UI grows) means a third copy of the same boilerplate and
  a third untyped handler.

## Fix Plan

Deepen into one panel module with one typed protocol.

1. **`PanelManager`** owns create / cache / reveal / dispose for every panel kind:

   ```ts
   panels.open({ kind: 'record', key, viewType: 'mEdit', title, scriptAsset: 'record.js' },
               onMessage);
   ```

   The `openPanels` map, dispose wiring, and `buildWebviewHtml` call move inside it. Both
   `openRecordPanel` and `openReferencedByPanel` collapse to one call each.

2. **Discriminated-union message type** shared by extension and webview:

   ```ts
   export type WebviewToExtension =
     | { type: 'openRecord'; formKey: string; label?: string }
     | { type: 'openRecordBeside'; formKey: string };
   export type ExtensionToWebview =
     | { type: 'loadRecord'; formKey: string };
   ```

   Handlers `switch` on `msg.type` with the payload narrowed — no `as` casts. The webview imports
   the same type, so a protocol change is a compile error on both sides.

## Decisions to make before implementing

1. **Where does the shared message type live** so both the extension build and the webview build
   import it? Likely a small `protocol.ts` under a shared path both tsconfig roots see. Confirm the
   webview bundle can import from it.
2. **Runtime validation at the boundary?** A discriminated union gives compile-time safety only;
   messages arrive as `unknown` at runtime. Decide whether a thin type guard (or zod-style check) is
   worth it, or whether compile-time + tests suffice for a single-consumer dev tool (cf. the
   "no guard tests" stance — we own both sides).
3. **Cache-key strategy.** Keep string keys (fine for well-formed FormKeys) or key the map by
   `{ kind, id }`. Low stakes; decide with the `PanelManager` shape.

## Related

- [extension.ts:232–281](../../medit-vscode/src/extension.ts#L232-L281) — `openRecordPanel`
- [ReferencedByPanel.ts](../../medit-vscode/src/ReferencedByPanel.ts) — parallel lifecycle
- [messages.ts](../../medit-vscode/src/messages.ts) — string constants, no payload types
- [webviewHtml.ts](../../medit-vscode/src/webviewHtml.ts) — shared HTML builder
- docs/UI_SPEC.md — webview design
