# mEdit

A modern xEdit — a VS Code extension and local C# service for editing Bethesda plugin files and managing a load order. The primary user is someone who has hit the limits of xEdit and wants a more capable, scriptable, agent-friendly tool. UI accessibility matters: new users shouldn't bounce off it, but the tool does not hide the domain from them.

## Language

### Records & identity

**Mod**:
A distributable package that may contain one or more plugins, loose asset files (textures, meshes, sounds), and BA2 archives. mEdit operates on the plugin component of a mod; asset management is out of scope for v1.
_Avoid_: plugin (a mod may contain many; they are distinct things)

**Plugin**:
A `.esp`, `.esm`, or `.esl` binary file that Bethesda games load to define or modify game records. The primary unit mEdit operates on.
_Avoid_: mod (a mod is the full distributable package, of which a plugin is one part)

**Record**:
A single named entity within a plugin — an NPC, weapon, cell, etc. — identified by its FormKey.
_Avoid_: entry, item

**FormKey**:
The canonical, cross-load-order identifier for a record. Composed of a FormID and the plugin that originally defined it (e.g. `000984:Skyrim.esm`). Stable regardless of which slot the plugin occupies in any given load order.
_Avoid_: FormID (that's the local integer part only)

**FormID**:
The 3-byte integer part of a FormKey, local to a single load-order slot. Not portable across different load orders.
_Avoid_: FormKey

**FormLink**:
A typed reference field on a record that holds the FormKey of another record. For example, an NPC record has a FormLink to its Race record. FormLinks form the reference graph that drives "Referenced By" queries and delete/renumber safety checks.

**EditorID (EDID)**:
A human-readable string identifier for a record (e.g. `NordRace`). Stable across load orders; not guaranteed globally unique.
_Avoid_: name, label

**Master**:
A plugin declared as a dependency in another plugin's header. Records in a master can be referenced by the dependent plugin via FormKey.
_Avoid_: parent plugin, base plugin

**Immutable plugin**:
A plugin that mEdit treats as read-only and will not write to. Currently derived from Mutagen's knowledge of which plugins are base-game files — it is not a property of the plugin file itself. The intent is to prevent accidental edits to files the user doesn't own.
_Avoid_: read-only plugin, locked plugin

**Patch**:
A plugin whose primary purpose is to hold overrides that reconcile conflicts between other plugins — rather than defining new records. A patch is a plugin by structure; the distinction is intent.
_Avoid_: patch plugin, conflict resolution plugin

### Load order & overrides

**Load order**:
The ordered list of plugins the game loads at runtime. Determines which override wins for every record.
_Avoid_: plugin list

**Override**:
A record definition in a plugin other than the record's originating plugin. The same FormKey appears in multiple plugins; each later plugin may change some or all field values.
_Avoid_: copy, patch entry

**Override stack**:
The full ordered sequence of overrides for a single FormKey across all loaded plugins, in load-order position. This is the primary thing the compare view displays, and the structure conflict detection operates over.

**Winning override**:
The last override in load order — the version of a record the game actually uses.
_Avoid_: active record, final record

**ITM (Identical to Master)**:
An override whose field values are byte-for-byte equal to the master record. Wastes a load-order slot with no effect.
_Avoid_: clean record (ambiguous)

**ConflictAll**:
The row-level conflict classification for a record's override stack as a whole. Drives the background color of a record row in the compare grid. Values in ascending severity:

- **OnlyOne** — the record exists in one plugin only; no override chain.
- **NoConflict** — all overrides agree on all field values. Pure ITMs.
- **ConflictBenign** — plugins differ on at least one field, but every differing field is marked low-priority (cosmetic or redundant in practice).
- **Override** — one or more plugins override the record, but the changes are uncontested — no two plugins disagree on the same field.
- **Conflict** — two or more plugins disagree on at least one field; the last plugin in load order wins.
- **ConflictCritical** — conflict on a field explicitly marked critical, or an injected record is in conflict.

_Avoid_: the old four-state "change lost / override / conflict / clean" shorthand — it conflates ConflictAll and ConflictThis.

**ConflictThis**:
The per-plugin classification for one plugin's version of a record in the override stack. Drives the cell color for that plugin's column in the compare grid. Independently tracked for each `(FormKey, plugin)` pair:

- **Ignored** — field has `cpIgnore` priority; excluded from conflict logic.
- **OnlyOne** — single-plugin record; no comparison.
- **Master** — this is the originating plugin's version (load-order position 0 for this FormKey).
- **IdenticalToMaster** — same values as the master; the override adds nothing.
- **ConflictBenign** — differs but the difference is low-priority.
- **Override** — uncontested change (no later plugin contradicts this field).
- **ConflictWins** — wins the conflict; this plugin's value is what the game uses.
- **ConflictLoses** — loses the conflict; this plugin's change is silently discarded by a later plugin.

"ConflictLoses" is the most insidious state: the load order appears to work but a mod's intended change is being overwritten without warning. See ADR-0016.

**ConflictPriority**:
A per-field modifier that changes how conflict detection behaves for that field. The common values: `cpIgnore` (skip entirely), `cpBenign` (cap at benign even if values differ), `cpBenignIfAdded` (benign when absent in master — used on Location Reference XLRL), `cpNormal` (standard), `cpCritical` (elevate to ConflictCritical). Defined by the xEdit field definition table; implemented in mEdit as a Tier 2 refinement. See ADR-0016.

**PartialForm**:
A record with the `IsPartialForm` header flag set. It intentionally omits fields it doesn't override — the absent fields are not "null" overrides, they are out-of-scope. In the compare grid, absent fields in a partial-form column are omitted entirely, not shown as blank cells. In conflict detection, absent partial-form fields are treated as `cpIgnore`.
_Avoid_: sparse record, incomplete override.

**Record filter**:
A DuckDB SQL SELECT stored on the backend session that narrows the record tree to a subset of FormKeys. While active, plugins and record types with no matching records are hidden. Cleared to restore the full tree. Stored as a plain `.sql` file in `mEdit.scriptsPath`; applied via Code Lens or `mEdit.setFilter`. A record filter is a degenerate script — a selection query with no Python body.
_Avoid_: search filter, query filter

**Filter file**:
A `.sql` file in `mEdit.scriptsPath` containing a DuckDB SELECT that returns a `form_key` column. VS Code provides syntax highlighting; a Code Lens provides the apply/clear affordance. Filter files and scripts share the same folder and the same file-based UX surface.
_Avoid_: filter script (scripts have a Python body; filter files do not)

**Script**:
A Python file with a YAML frontmatter block that declares a SQL query (selecting which records to operate on) and a Python body that iterates those records and calls `edit()` to stage changes. Scripts are the preferred agent output for complex multi-record operations — they are reviewable, rerunnable, and deterministic. All `edit()` calls route through `PendingChangeService`, the same as manual edits. See Phase 15.
_Avoid_: macro, automation

### Agentic workflows

**Agent**:
A VS Code chat participant or Language Model tool that assists with mod editing. Agents may call the HTTP API directly for simple tasks, or generate a script for complex multi-record operations where the intent should be reviewable before execution. All edits — whether from direct API calls or script execution — land in pending changes for user approval. See ADR-0012, ADR-0013.

### Session & index

**Session**:
The active game environment: a chosen game release plus a load order, loaded into memory and indexed.
_Avoid_: workspace, environment

**Index**:
The DuckDB read model of committed record data. Rebuilt from plugins on session load. A cache, not a source of truth — deleting it loses nothing.
_Avoid_: database, store

**Pending change**:
A staged field edit held in memory, not yet written to disk. Visible to the UI but not reflected in the index until saved.
_Avoid_: draft, unsaved edit
