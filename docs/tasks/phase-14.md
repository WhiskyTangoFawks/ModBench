# Phase 14 — Plugin File Management

**Status: Not Started**

*Goal: operations mod authors need for preparing plugins for distribution or integration.*

## Backend
- [ ] `POST /plugins/{plugin}/compact-formids` — renumber non-master FormIDs into 0x001–0xFFF range for ESL eligibility; returns `{ remapped: int, backupPath: string }`
- [ ] `POST /plugins/{plugin}/convert` — toggle ESL/ESM flag; request body `{ targetType: "esp"|"esm"|"esl" }`
- [ ] `POST /plugins/{plugin}/masters/add` — add a new master reference to the plugin header
- [ ] `POST /plugins/{plugin}/masters/sort` — reorder masters to match current load order
- [ ] `POST /plugins/{plugin}/masters/clean` — remove unused master references (not referenced by any record)
- [ ] `POST /plugins/merge` — merge source plugin records into target plugin; adjusts FormID mapping; creates backup
- [ ] `POST /plugins/{plugin}/records/inject-to-master` — move records from this plugin into its declared master: transfers the record definition into the master plugin and removes it from the dependent; adjusts FormIDs and all intra-load-order references; creates backups of both plugins before writing
- [ ] Master auto-update on copy-to: when `PluginWriter` writes a copied record into a target plugin, automatically add the source plugin as a master of the target if not already present; `POST /copy-to` must never leave a plugin referencing a FormKey whose origin is not declared in the header

## Extension
- [ ] Plugin context menu: "Compact FormIDs", "Convert to ESL / ESM", "Add Master…", "Sort Masters", "Clean Masters", "Inject Forms into Master…", "Merge Into…"
- [ ] Confirmation dialogs for all destructive operations
- [ ] Result notification (backup path, counts)

## Tests
- [ ] Backend: `compact-formids` renumbers records and updates all cross-references within the plugin
- [ ] Backend: `masters/clean` removes only the unreferenced master
- [ ] Backend: `inject-to-master` moves record into master and removes it from the dependent; both plugins updated atomically
- [ ] Backend: copy-to automatically adds the source as a master of the target plugin when the master declaration is absent

## Proof

*To be filled in on completion. Paste `dotnet test` output, `npm run test:unit` output, and commit hash here.*
