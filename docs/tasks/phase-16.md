# Phase 16 — Worldspace / Cell Tree

**Status: Not Started**

*Goal: WRLD and CELL records render in their correct spatial hierarchy in the tree, matching xEdit's world-tree structure.*

Background: Bethesda plugins use two distinct record hierarchies for placed objects. **Worldspaces** (WRLD) group CELL records spatially into blocks → sub-blocks → cells (identified by XCLC grid coordinates), each containing Persistent and Temporary REFR groups. **Interior cells** (CELL without a worldspace parent) appear as a flat list. The current tree shows CELL and REFR as a flat list under their record type — this phase restructures them into the correct hierarchy.

## Backend
- [ ] `GET /worldspaces` — returns WRLD records for the session; each entry: `{ formKey, editorId, plugin }`
- [ ] `GET /worldspaces/{formKey}/blocks` — spatial hierarchy for one worldspace: `{ blocks: [{ x, y, subBlocks: [{ x, y, cells: [{ formKey, editorId, cellX, cellY }] }] }] }`; XCLC coordinates sourced from the `XCLC` field on each CELL record
- [ ] `GET /cells/{formKey}/references` — REFR records inside a specific CELL, split into `{ persistent: RecordSummary[], temporary: RecordSummary[] }`; Persistent vs Temporary derived from the child-group type in the plugin binary structure
- [ ] `GET /interior-cells` — CELL records with no worldspace parent; supports pagination

## Extension
- [ ] "Worldspaces" top-level tree node (alongside existing plugin/record-type nodes); lazy-loads `GET /worldspaces`
- [ ] WRLD child nodes expand to Block nodes (labelled e.g. "Block 0, 0"); Block nodes expand to Sub-block nodes; Sub-block nodes lazy-load CELL children from `GET /worldspaces/{fk}/blocks`
- [ ] CELL node labelled by XCLC grid coordinates (e.g. "Cell (12, -5)") or EditorID when present; click opens record editor
- [ ] Persistent and Temporary child nodes under each CELL; lazy-load REFR children from `GET /cells/{fk}/references` on expand
- [ ] REFR leaf nodes labelled as "EditorID [REFR:FormID]"; click opens record editor
- [ ] "Interior Cells" top-level node; lazy-loads `GET /interior-cells`

## Tests
- [ ] Backend: `GET /worldspaces/{fk}/blocks` returns correct block/sub-block/cell nesting for a fixture with a known WRLD record
- [ ] Backend: XCLC coordinates are correctly read from cell records and reflected in the response
- [ ] Backend: `GET /cells/{fk}/references` separates persistent and temporary REFRs correctly
- [ ] Backend: `GET /interior-cells` returns only cells that have no WRLD parent

## Proof

*To be filled in on completion. Paste `dotnet test` output, `npm run test:unit` output, and commit hash here.*
