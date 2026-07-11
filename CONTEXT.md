# CONTEXT

## Domain Language

### Records & identity

**Mod**: Distributable package (plugins + loose assets + BA2s). mEdit operates on plugins only. _Avoid: plugin._

**Plugin**: `.esp`/`.esm`/`.esl` binary; primary unit mEdit operates on. _Avoid: mod._

**Record**: Named entity in a plugin (NPC, weapon, cell, etc.), identified by FormKey. _Avoid: entry, item._

**FormKey**: Cross-load-order record identifier: FormID + originating plugin (e.g. `000984:Skyrim.esm`). Stable regardless of load-order slot. _Avoid: FormID._

**FormID**: 3-byte integer part of a FormKey; local to one load-order slot. Not portable. _Avoid: FormKey._

**FormLink**: Typed reference field on a record holding another record's FormKey. FormLinks form the reference graph for "Referenced By" and delete/renumber safety checks. Some FormLink fields permit a null FormKey (Mutagen `IFormLinkNullable<T>`); others require a non-null target (`IFormLink<T>`).

**Null FormLink**: A FormLink holding `FormKey.Null`. Valid on fields that permit null; a data error on fields that don't.

**Dangling FormLink**: A FormLink holding a well-formed FormKey that does not resolve to any record in the current session. Always a data error — creation is blocked at stage time; existing occurrences in loaded plugins are flagged, not hidden. _Avoid: missing reference, broken link._

**Type-Mismatched FormLink**: A FormLink that resolves to a record of a type other than the field's declared valid types (e.g. a weapon-typed field pointing to an NPC). Always a data error, handled the same way as a Dangling FormLink. _Avoid: wrong-type reference._

**EditorID (EDID)**: Human-readable string identifier (e.g. `NordRace`). Stable across load orders; not guaranteed unique. _Avoid: name, label._

**Master**: Plugin declared as a dependency in another plugin's header. _Avoid: parent plugin, base plugin._

**Immutable plugin**: Plugin mEdit treats as read-only — base-game files per Mutagen. Not a property of the file itself. _Avoid: read-only plugin, locked plugin._

**Patch**: Plugin whose purpose is holding overrides that reconcile conflicts. Same structure as any plugin; distinction is intent. _Avoid: patch plugin, conflict resolution plugin._

### Load order & overrides

**Plugin load order**: Ordered list of plugins the game loads (`plugins.txt`); determines which override wins. Written by Mod Management (the Plugins tab); Editing consumes it read-only to build a session (`load-explicit`). Distinct from Mod Management's mod-level ordering (file conflicts, not overrides) — see [CONTEXT-MAP.md](CONTEXT-MAP.md). _Avoid: load order (ambiguous with Mod load order), plugin list._

**Override**: Record definition in a plugin other than the originating plugin. _Avoid: copy, patch entry._

**Override stack**: Full ordered sequence of overrides for one FormKey across all loaded plugins. Primary structure for the compare view and conflict detection.

**Winning override**: Last override in plugin load order — what the game actually uses. _Avoid: active record, final record._

**ITM (Identical to Master)**: Override byte-for-byte equal to the master; wastes a load-order slot with no effect. _Avoid: clean record._

**ConflictAll**: Row-level conflict classification for a record's override stack. Drives record-row background color. Values (ascending severity):

- **OnlyOne** — exists in one plugin only
- **NoConflict** — all overrides agree
- **ConflictBenign** — plugins differ but only on low-priority fields
- **Override** — overrides present; no two plugins disagree on the same field
- **Conflict** — two or more plugins disagree on at least one field; last plugin wins
- **ConflictCritical** — conflict on a critical field, or injected record in conflict

_Avoid: the old four-state shorthand — it conflates ConflictAll and ConflictThis._

**ConflictThis**: Per-plugin classification for one plugin's version of a record. Drives cell color in the compare grid.

- **Ignored** — `cpIgnore` priority; excluded from conflict logic
- **OnlyOne** — single-plugin record
- **Master** — originating plugin's version
- **IdenticalToMaster** — same values as master
- **ConflictBenign** — differs but low-priority
- **Override** — uncontested change
- **ConflictWins** — wins; game uses this value
- **ConflictLoses** — loses; change silently overwritten by a later plugin ← most insidious state. See ADR-0016.

**ConflictPriority**: Per-field modifier affecting conflict detection. Values: `cpIgnore`, `cpBenign`, `cpBenignIfAdded`, `cpNormal`, `cpCritical`. See ADR-0016.

**PartialForm**: Record with `IsPartialForm` header flag. Absent fields are out-of-scope, not null overrides. In compare grid: absent fields omitted (not shown as blank). In conflict detection: treated as `cpIgnore`. _Avoid: sparse record, incomplete override._

### Session & index

**Session**: Active game environment: chosen game release + plugin load order, loaded and indexed. _Avoid: workspace, environment._

**Index**: DuckDB read model of committed record data. Rebuilt on session load. Cache, not source of truth — deleting it loses nothing. _Avoid: database, store._

**Pending change**: Staged field edit held in memory; not yet written to disk. For complex fields, stores the entire new field value atomically — no per-element pending change. _Avoid: draft, unsaved edit._

**ChangeGroup**: Batch of pending changes staged by one record-lifecycle operation (create, delete, renumber), saved or reverted atomically as a unit — possibly spanning plugins (e.g. a renumber's cascading reference updates). Surfaced in the Pending Changes tree. _Avoid: transaction, batch edit._

**Complex field**: Field of type `array` or `struct`. Always committed as one atomic pending change; revert is all-or-nothing at the column level. _Avoid: compound field, nested field._

**Sorted array**: Array with a stable sort key (e.g. `Keywords`, `Perks`, keyed by FormKey). In compare grid: elements aligned by sort key across columns. See ADR-0019. _Avoid: keyed array._

**Unsorted array**: Array with positional elements and no natural sort key (e.g. `Packages`, `Factions`). In compare grid: aligned by index. _Avoid: indexed array._

**VMAD (Virtual Machine Adapter)**: Papyrus scripting subrecord on NPC\_, QUST, PERK, PACK, SCEN, INFO, others. Contains named scripts with named properties (bool, int, float, string, FormKey, struct, and array variants). Has dedicated DuckDB tables; does not go through `SchemaReflector`. See phase-13.md, ADR-0019. _Avoid: script data, Papyrus data._

### Filters & scripts

**Record filter**: DuckDB SELECT stored on the backend session that narrows the record tree. Stored as `.sql` in `modbench.scriptsPath`; applied via Code Lens or `modbench.setFilter`. A degenerate script — selection only, no Python body. _Avoid: search filter, query filter._

**Filter file**: `.sql` file in `modbench.scriptsPath` returning a `form_key` column. Shares folder/UX surface with scripts but has no Python body. _Avoid: filter script._

**Script**: Python file with YAML frontmatter declaring a SQL query + Python body that iterates records and calls `edit()`. All `edit()` calls route through `PendingChangeService`. Preferred agent output for complex multi-record operations — reviewable, rerunnable, deterministic. See Phase 15. _Avoid: macro, automation._

**Agent**: VS Code chat participant or LM tool. May call the HTTP API directly for simple tasks or generate a script for complex ones. All edits land in pending changes. See ADR-0012, ADR-0013.
