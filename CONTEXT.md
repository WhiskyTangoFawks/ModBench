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

**Dangling FormLink**: A FormLink holding a well-formed FormKey that does not resolve to any record in the current session. Always a data error — creation is blocked at edit time; existing occurrences in loaded plugins are flagged, not hidden. _Avoid: missing reference, broken link._

**Type-Mismatched FormLink**: A FormLink that resolves to a record of a type other than the field's declared valid types (e.g. a weapon-typed field pointing to an NPC). Always a data error, handled the same way as a Dangling FormLink. _Avoid: wrong-type reference._

**EditorID (EDID)**: Human-readable string identifier (e.g. `NordRace`). Stable across load orders; not guaranteed unique. _Avoid: name, label._

**Master**: Plugin declared as a dependency in another plugin's header, required because the header's own FormIDs are indexed against this list. Derived entirely from what the plugin's content actually references — never directly added, removed, sorted, or cleaned by the user (ADR-0038). A master reference is validated against the loaded plugins — a reference naming no loaded plugin is classified and flagged (`DirectlyMissing` when the file is absent from the session entirely, `Unloadable` when it is present but itself failed to load) while the declaring plugin stays indexed, browsable, and participating in winner computation; it is never deactivated (ADR-0037). _Avoid: parent plugin, base plugin._

**Header record**: A plugin's ModHeader (author, masters, flags) modeled as a first-class, single-column record at synthetic FormKey `000000:<plugin>`. Not an override of any other plugin's header — headers do not conflict across plugins. Editing its author or ESL/ESM flags goes through the normal edit path (working-tree text, ADR-0041); its masters do not — they're read-only, computed from content at compile (see Master, Effective masters). _Avoid: TES4 record (internal jargon), plugin metadata._

**Effective masters**: The masters a plugin will actually have once its current working-tree edits are compiled — compiled masters unioned with the origin plugins referenced by uncommitted source changes. What validation and the header panel read before compile; never itself an edit, since masters are derived, not authored (ADR-0038). _Avoid: pending masters, staged masters._

**Immutable plugin**: Plugin mEdit treats as read-only — base-game files per Mutagen. Not a property of the file itself. _Avoid: read-only plugin, locked plugin._

**Patch**: Plugin whose purpose is holding overrides that reconcile conflicts. Same structure as any plugin; distinction is intent. _Avoid: patch plugin, conflict resolution plugin._

### Load order & overrides

**Plugin load order**: Ordered list of plugins the game loads (`plugins.txt`); determines which override wins. Written by Mod Management (the Plugins tab); Editing consumes it read-only to build a session (`load-explicit`). Distinct from Mod Management's mod-level ordering (file conflicts, not overrides) — see [CONTEXT-MAP.md](CONTEXT-MAP.md). _Avoid: load order (ambiguous with Mod load order), plugin list._

**Override**: Record definition in a plugin other than the originating plugin. Record-level — where the level could be ambiguous, say *record override* (see Resolution stack). _Avoid: copy, patch entry._

**Override stack**: Full ordered sequence of overrides for one FormKey across all loaded plugins. Primary structure for the compare view and conflict detection.

**Resolution stack**: The one model recurring at three levels: a stack of candidates on a shared identity, resolved to a single winner (#397). **File level** — multiple mods provide the same plugin filename; Mod ordering resolves which file exists (MO2 calls this "overwritten" — its dialect for the same thing). **Record level** — multiple plugins provide the same FormKey; plugin load order resolves the winner (the Override stack above). **State level** — within a tracked copy, source stacks on the compiled binary; the working tree wins in the editor, and compile collapses the layer. "Override"/"overwrite" unqualified is inherently vague across levels — always name the level: *file override*, *record override*, *source override*. Editability is orthogonal to the stack: load-order membership decides write access, so a file-level loser is read-only even when tracked. _Avoid: shadowed plugin (pre-#397 term for a file-level loser), override/overwrite unqualified where the level isn't obvious from context._

**Underride**: The mirror of an override — placing a record *down* into an earlier-loading plugin (a master) rather than up into a later one. Because a FormKey encodes its origin plugin, an underride entails renumbering the record into the target master's FormID range (cf. xEdit "inject into master"), so mechanically it is a move+renumber despite the copy-flavored name. _Avoid: inject, inject-to-master._

**Winning override**: Last override in plugin load order — what the game actually uses. _Avoid: active record, final record._

**ITM (Identical to Master)**: Override byte-for-byte equal to the master; wastes a load-order slot with no effect. _Avoid: clean record._

**ConflictAll**: Conflict classification for an override stack, computed at two independent scopes (#114, [ADR-0016](docs/adr/0016-two-axis-conflict-model.md)): **record-wide** (one value per record — drives the Plugins-tree's record-node badge) and **per-node, bottom-up** (one value per compare-grid row — a leaf reduces its own cross-plugin values; a struct/array node aggregates the worst state anywhere in its subtree, and shows that aggregate while collapsed but defers to its own children's individual values while expanded). Same values, same severity order, at both scopes — only the tree scope over which they're folded differs. Drives row background color at whichever scope applies. Values (ascending severity):

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

**Index**: DuckDB read model of record data: one documents table (each record's source JSON as its body) plus extracted index tables (FormKey lookup, references, placements) and generated `json_extract` views that preserve filter SQL (ADR-0041). Rebuilt on session load. Cache, not source of truth — deleting it loses nothing. _Avoid: database, store._

**Source**: The JSON text tree (`<plugin>.source/**`) inside a tracked mod's folder, versioned by that folder's own `.git` repository (ADR-0041, ADR-0042). A tracked mod's source is *complete and lossless*: it is the editable form of the plugin — compiling it reproduces the plugin byte for byte, and that round trip is the gate (run in tests and at Track; a plugin that fails it is refused). The format is Modbench's own, not Spriggit's (ADR-0042): nothing is omitted and nothing is re-sorted in the files (noise-hiding and sorting are view-layer concerns — diff view, editor — never the files), and every folder-split list carries its order in `[N] ` filename prefixes. Layout: group folders (`Weapons/<EditorID> - <FormKey>.json`), block/sub-block containment for Cells and Worldspaces (`Cells/<block>/<subblock>/<name>/RecordData.json`, `Worldspaces/<ws>/<X, Y>/<X, Y>/<name>/RecordData.json`), and a root `RecordData.json` holding the mod header's own fields plus the format identity (Mutagen version + layout version — a mismatch refuses the mod with a re-Track instruction). "One *source unit* = one file": Cell's `{Temporary,Persistent,Landscape,NavigationMeshes}` and Worldspace's `TopCell` embed inline in their parent's own document, while Quest's `{DialogBranches,DialogTopics,Scenes}` and DialogTopic's `Responses` are folder-split, containment expressed as the path either way. _Avoid: ledger (the pre-#437 name — reads as "source" everywhere it survives, e.g. ADR-0041), text mirror, Spriggit repo, Spriggit tree, view/projection (the text is input, not a rendering), stamp/source format (the retired Spriggit-version idea), committed plugin (withdrawn same day — the binary is never in the repo), compiled artifact (for the binary — it is the truth, not the output)._

**Tracked mod**: A mod whose folder contains a `.git` repository — tracking *is* the presence of `.git`, stateless, no registry (ADR-0041). Created only by the user's explicit Track gesture; destroyed with the folder (or the `.git` within it), at which point the mod simply reads as untracked again. Editing requires tracking; viewing never does — untracked plugins are hard read-only in the editor. _Avoid: tracked record (tracking is per-mod), vendored mod._

**Track**: The explicit user gesture that creates a mod's repository: eagerly serialize every record of its plugins to the source, verify the round-trip gate over every record (refusing the plugin, naming the record, if it does not round-trip — ADR-0042), commit the complete pristine state to `main` (with provenance trailers), generate the `.gitignore` from a preset (Edits or Everything; plugin binaries are never tracked — the root plugin is the one plugin, ADR-0042), then create and check out the edit branch. One-time, progress-reported cost. _Avoid: vendor (the retired first-touch mechanism), init._

**Edit branch**: The checked-out branch a tracked Downloaded mod's edits live on, created at track time; `main` holds pristine upstream state and is never checked out in normal use. `git diff main <branch>` is "everything I changed"; checking out `main` and compiling restores the pristine plugin. Authored vs Modified is a workflow choice, not a stored mode (ADR-0041 amendment): "Authored" merges the edit branch into `main` at will (no pristine to preserve), "Modified" keeps `main` pristine; Track is uniform and Modbench never branches on the distinction. _Avoid: working branch, dev branch._

**Baseline**: A pristine-state commit on a tracked mod's `main` — the complete serialization at track time, or the re-serialization of an upstream update. Carries provenance trailers. User edits diff and rebase against it via ordinary git. _Avoid: original, base version._

**Provenance**: Informational commit trailers on `main` baselines — the pristine binary's SHA-256 and the upstream version string — read by humans and agents, never by classification machinery (ADR-0041 retired the opaque cross-context payload). _Avoid: metadata, Anchor (Mod Management's term)._

**Save & Compile**: The gesture that writes a tracked plugin's binary: serialize the working-tree source text to the binary, deriving the masters list and renumber cascades (the format makes those non-optional — ADR-0038), refusing only what it structurally cannot emit, and reporting everything else as Problems-panel diagnostics. Compile is to the plugin's source what a compiler is to source code; commit is git's own gesture, ungated and orthogonal — history may hold states that don't build (ADR-0041; ADR-0042 briefly gated it and withdrew that the same day). Each compile parks a snapshot commit of the compiled working tree at `refs/medit/last-compile/<plugin>` (trailer: `Binary-SHA256`) — the reference for "the binary as Modbench last wrote it", never on the branch (ADR-0041 amendment). _Avoid: save (alone — it hides the compile), apply, rebuild (pre-ADR-0041 term)._

**Working-tree change**: An edit not yet committed — ordinary git dirt in the source, shown by the native Source Control panel per tracked mod. This is the only "pending" state that exists; the staged pending-change model and change groups are retired (ADR-0041 superseding ADR-0017/0028). _Avoid: pending change, staged edit, change group._

**Complex field**: Field of type `array` or `struct`. Always edited as one atomic value — a field-level write to the source document, never per-element; revert is all-or-nothing at the column level. _Avoid: compound field, nested field._

**Sorted array**: Array with a stable sort key (e.g. `Keywords`, `Perks`, keyed by FormKey). In compare grid: elements aligned by sort key across columns. See ADR-0019. _Avoid: keyed array._

**Unsorted array**: Array with positional elements and no natural sort key (e.g. `Packages`, `Factions`). In compare grid: aligned by index. _Avoid: indexed array._

**Child record**: Record type reachable through another record's array field but enumerated as its own top-level record row rather than nested inline (e.g. Quest's `Scenes` → SCEN, `DialogTopics` → DIAL, DialogTopic's `Responses` → INFO). Mutagen flattens it, so it carries its own FormKey and surfaces its own fields — including any conditions it owns — through its own top-level record; it must never also be re-nested inside its parent's row, which would duplicate them. Distinguishes an array holding true child records from one holding a plain sub-record struct with no FormKey of its own (e.g. Perk's `Effects`, holding `Effect`). See #169. _Avoid: sub-record (ambiguous with a plain struct), nested record._

**VMAD (Virtual Machine Adapter)**: Papyrus scripting subrecord on NPC\_, QUST, PERK, PACK, SCEN, INFO, others. Contains named scripts with named properties (bool, int, float, string, FormKey, struct, and array variants). Has dedicated DuckDB tables; does not go through `SchemaReflector`. See phase-13.md, ADR-0019. _Avoid: script data, Papyrus data._

**Condition (CTDA)**: A record's condition-testing list (Mutagen `Condition`, on-disk CTDA subrecord) — e.g. COBJ/Quest/Perk's `Conditions`, or Quest's `DialogConditions`/`UnusedConditions`. Discovered generically by shape (any property assignable to `IEnumerable<IConditionGetter>`), never a hardcoded field name, so a record with more than one condition-carrying field surfaces one independently-keyed group per field. Also discovered one array level below the record, inside a struct or list-of-struct field (e.g. `Perk.Effects[i].Conditions`), keyed by an indexed field path composing the enclosing array's own name and index (`Effects[2].Conditions`) — excluding any path through a Child record, which already surfaces its own conditions through its own top-level field. Has dedicated DuckDB tables; does not go through `SchemaReflector`. See ADR-0032, #150, #169. _Avoid: CTDA as glossary vocabulary (fine as the wire-path prefix in code)._

### Filters & scripts

**Record filter**: DuckDB SELECT stored on the backend session that narrows the record tree. Stored as `.sql` in `modbench.scriptsPath`; applied via Code Lens or `modbench.setFilter`. A degenerate script — selection only, no Python body. _Avoid: search filter, query filter._

**Filter file**: `.sql` file in `modbench.scriptsPath` returning a `form_key` column. Shares folder/UX surface with scripts but has no Python body. _Avoid: filter script._

**Script**: Plain `.py` file, no special syntax — imports `medit` and calls `medit.query(sql)` (optional; a script may drive several queries across record types, or none) and `edit()`/`row.set()` to make edits. All `edit()` calls route through the normal edit path (working-tree text on the mod's edit branch, ADR-0041). Runs as a normal Python process (any interpreter, any tool) since it's an HTTP client of the backend, not a backend-spawned subprocess — ADR-0024. Preferred agent output for complex multi-record operations — reviewable, rerunnable, deterministic. See Phase 15, issue #2. _Avoid: macro, automation, frontmatter script (superseded design)._

**Agent**: VS Code chat participant or LM tool. May call the HTTP API directly for simple tasks or generate a script for complex ones. All edits land as working-tree changes, reviewable in the native git UI. See ADR-0012, ADR-0013.
