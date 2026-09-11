# Modbench domain language

Modbench is one tool with two bounded contexts. **Editing** is the mEdit service and the record
editor's surfaces: it speaks in plugins, records and FormKeys and never says "mod". **Mod
Management** is the Toolbox, Mods, Plugins and Downloads views: it speaks in mods, modlists and
files and never sees a record. They meet at one object, a plugin file at a physical path, which
Mod Management hands Editing inside the Plugin load order
([ADR-0013](docs/adr/0013-mod-management-hands-editing-the-load-order.md)). The Plugins tree is
Mod Management's and also shows Editing's records
([ADR-0017](docs/adr/0017-mo2-is-the-reference-for-mod-management.md)). Architecture words
live in [ADR-0014](docs/adr/0014-modules-are-layered-and-call-adjacent-layers-through-ports.md).

## Shared language

**Override order**:
The ordering that decides who wins a conflict, defined only by its two ends and never by a
position in a file or a view. Two instances: the **Mod override order** (`modlist.txt`), which
decides file conflicts, and the **Plugin load order** (`plugins.txt`), which decides record
conflicts. Always say which.
_Avoid_: load order unqualified, priority, shadowed plugin (say file-level loser)

**Winning / losing**:
The two ends of an override order: A wins over B, B loses to A, the extremes are winning-most
and losing-most. Vanilla content is losing-most on both axes: the base game's records lose to
every plugin and its files lose to every mod.
_Avoid_: high or low priority, top or bottom (view words)

**Plugin load order**:
The ordered list of plugins the game loads. Mod Management owns and writes it; Editing holds the
value it is handed (ADR-0013).
_Avoid_: load order unqualified, plugin list, session

**Load order snapshot**:
The value Mod Management sends Editing: every plugin copy in the instance with its slot, whether
its line is enabled, and whether it wins its name. The only thing called a snapshot.
_Avoid_: mod override snapshot

## Editing

### Records and identity

**FormLink**:
A typed field holding another record's FormKey. Two data errors, both flagged: **dangling**, a
FormKey that resolves to no record in the load order, and **type-mismatched**, one that resolves
to a record of a type the field does not permit.
_Avoid_: missing reference, broken link, wrong-type reference

**Effective masters**:
The masters a plugin will have once its working-tree edits compile: its compiled masters plus the
plugins its uncommitted changes reference.
_Avoid_: pending masters, staged masters

**Header record**:
A plugin's own header, its author, masters and flags, held as a record like any other. A header
is not an override of another plugin's header.
_Avoid_: TES4 record, plugin metadata, header table

**Immutable plugin**:
A plugin Editing treats as read-only: the base game's own files.
_Avoid_: read-only plugin, locked plugin

### Load order and overrides

**Participation**:
Whether a registered plugin copy competes for winner and counts in a conflict: enabled, winning
its name, and named by a line. A non-participating copy is indexed but never a winner (ADR-0012).
_Avoid_: loaded, active, shadowed

**Underride**:
Placing a record into an earlier-loading plugin rather than a later one. Because a FormKey
encodes its origin, an underride is a move plus a renumber.
_Avoid_: inject, inject-to-master

**Container record**:
A record whose plugin form owns a child group, CELL, WRLD, DIAL or QUST, so its children exist
only in a plugin that also carries it. In source, a container's children are embedded in its
document (ADR-0006).
_Avoid_: parent record, group record

**Embedded**:
A child record held inline in its container's document rather than in a file of its own.
_Avoid_: the hyphenated coinage for splitting a folder, nested file

**Partial form**:
A container override that exists only to carry children. Its own fields are ignored for conflict
resolution and omitted from the compare grid.
_Avoid_: empty override, sparse record, ITM parent

**ConflictAll**:
The classification of a record's override stack as a whole: OnlyOne, NoConflict, Override,
Conflict or ConflictCritical, in that severity order (ADR-0018).
_Avoid_: the four-state shorthand

**ConflictThis**:
The classification of one plugin's version within a stack: OnlyOne, Master, IdenticalToMaster,
Override, ConflictWins or ConflictLoses.

### Source and tracking

**Tracked mod**:
A mod whose folder holds a `.git` repository, created by Track. Editing requires tracking;
viewing never does (ADR-0007).
_Avoid_: tracked record, vendored mod

**Track**:
The user gesture that creates a mod's repository and its source (ADR-0007).
_Avoid_: vendor, init

**Source**:
The document tree inside a tracked mod's folder, one file per record with children embedded,
versioned by the mod's own repository. Semantically lossless: compiling it reproduces the
plugin's model (ADR-0006).
_Avoid_: ledger, text mirror, Spriggit tree, view, projection, committed plugin, compiled artifact

**Semantically lossless**:
The round-trip requirement: a source compiles to a plugin whose every record is model-identical
to the original (ADR-0006).
_Avoid_: byte-identical, lossless unqualified

**Edit branch**:
The branch a tracked mod's edits live on. `main` holds the pristine upstream state.
_Avoid_: working branch, dev branch

**Baseline**:
A pristine-state commit on a tracked mod's `main`: the serialization at Track, or of an upstream
update.
_Avoid_: original, base version

**Provenance**:
The commit trailers on a baseline: the pristine binary's hash and the upstream version. Never a
trigger.
_Avoid_: metadata, Anchor (Mod Management's term)

**External change**:
A tracked mod whose plugin bytes or git-tracked files differ from what Modbench last wrote,
classified per mod and answered by one dialog (ADR-0003).
_Avoid_: drift, conflict (that is a record-level word)

**Tell**:
`meta.ini`'s role in an external change: its version against the baseline trailer picks the
dialog's default. It raises nothing.
_Avoid_: trigger, signal

**Save & Compile**:
The gesture that writes a tracked plugin's binary from its source (ADR-0007).
_Avoid_: save, apply, rebuild

**Working-tree change**:
Git's uncommitted change, in the source. The only pending state there is.
_Avoid_: pending change, staged edit, change group

**Reconcile**:
A check of the record index against the plugin files and source trees by content hash, and the
same word for bringing it to a newly sent Plugin load order.
_Avoid_: reload, refresh (a view word), sync

**Record index**:
The read model of record data, one row per record per plugin copy, rebuilt from the plugin files
and the source trees and never a source of truth (ADR-0009, ADR-0011).
_Avoid_: index, the Index, DuckDB, database, store, cache

### Diagnosis and repair

**Diagnosis**:
The named finding on a plugin that Track, Save & Compile or a reconcile could not take as-is: the
record, the defect, and whether it is repairable losslessly, repairable with loss, or blocked
upstream.
_Avoid_: error, parse error, warning

**Malformed plugin**:
A plugin whose bytes depart from what the Creation Kit writes, provably, because every vanilla
record of the type shows the canonical form. Distinct from a correct plugin Mutagen mishandles.
_Avoid_: broken plugin, corrupt plugin, dirty plugin

**Repair**:
The explicit gesture that rewrites a malformed plugin into its canonical form (ADR-0006). Not
xEdit's clean, and not crash recovery.
_Avoid_: fix, clean, sanitize, normalize, crash repair

### Fields

**Complex field**:
An array or struct field, edited as one value.
_Avoid_: compound field, nested field

**Child record**:
A record reachable through another record's array field but carrying its own FormKey, so it is
its own record. Distinct from a struct element with no FormKey.
_Avoid_: sub-record, nested record

### Filters

**Record filter**:
A SQL SELECT, stored as a `.sql` file in the scripts folder, that narrows the record tree to the
FormKeys it returns.
_Avoid_: search filter, query filter, filter script

## Mod Management

### Mods and downloads

**Authored mod**:
A mod the user owns outright, created in Modbench or adopted, with no upstream. The only kind
whose full content may be shared.
_Avoid_: custom mod, personal mod, own mod

**Downloaded mod**:
A mod installed from a Download or any other external source, whose upstream defines the
pristine content it derives from. Ownership, not transport, is the split.
_Avoid_: third-party mod, external mod

**Modified**:
The state of a Downloaded mod whose files have diverged from what its upstream installed. Derived
by comparison, never declared. Only the divergence may be shared.
_Avoid_: modified mod as a kind, edited mod, tweaked mod

**Adopt**:
Take ownership of a Modified mod: reclassify it as Authored and sever the upstream link. One way.
_Avoid_: fork, convert

**Upstream**:
The lineage of pristine content a Downloaded mod derives from, the author's releases as
installed. For a tracked mod's plugins that comparison is Editing's (ADR-0007).
_Avoid_: origin (Editing's plugin-identity term), source

**Download**:
MO2's downloaded archive in the instance's `downloads/` folder, with its `.meta` sidecar. The
uninstalled state of a mod. Two orthogonal axes: **status**, Downloaded, Installed or
Uninstalled; and **hidden**, dismissed from view, held in MO2's own form so both tools hide the
same rows. Hiding is a command; showing hidden rows is a view setting.
_Avoid_: archive (that is a BA2 or BSA), package, Removed (MO2's `.meta` key for hidden), deleted

**Upgrade**:
Installing a download over a mod already installed from the same Nexus mod id: the folder's
contents are replaced in place around `.git`, so the mod keeps its identity.
_Avoid_: reinstall, update (Nexus's own word for a different gesture)

### Instance and profile

**Instance**:
The MO2 instance directory Modbench is opened on, and the one read model derived from its files
([ADR-0015](docs/adr/0015-edits-reach-the-read-model-through-the-watcher.md)). Everything a view
shows on the MO2 side is read from it; nothing writes to it.
_Avoid_: loadout, workspace, model

**Toolbox**:
The view that presents the instance, MO2's top bar as two rows, Profile and Deployment.
_Avoid_: Loadout, header, dashboard

**Profile**:
An MO2 profile. The active one is the only one the Instance reflects.
_Avoid_: session, loadout

**Separator**:
MO2's separator. A mod belongs to the same separator whichever way the list is displayed.
_Avoid_: group, category, treating a separator as a priority position

**View order**:
A view setting: how a list is displayed, winning-at-top or losing-at-top. It never changes who
wins.
_Avoid_: conflating with override order

**Command**:
A CQRS command: a gesture that writes an MO2 file, a mod folder or a download sidecar and
returns (ADR-0015).
_Avoid_: action, operation

**View setting**:
A gesture that changes only what a view displays and writes no MO2 file: View order, Show hidden.
It lives inside the view that owns it and never enters the watch loop.
_Avoid_: filter (that is the name filter), toggle, preference

### Files and deploy

**File conflict**:
Two enabled mods providing the same relative file; the mod nearer the winning end of the Mod
override order wins. Distinct from a record-level conflict, which is Editing's.
_Avoid_: override (record-level), higher-priority (say winning)

**File conflict index**:
Mod Management's index over every relative path the enabled mods provide, recording which mod
wins each one. Distinct from the record index.
_Avoid_: index, the Index, conflict index, winner map

**Deploy**:
Make the enabled mods' files present in the game directory so the running game reads them.
_Avoid_: install, link, mount, build

**Purge**:
Remove deployed mod files, returning the game directory to its pre-deploy state.
_Avoid_: uninstall, clean, teardown

**Game directory**:
The game installation Modbench reads vanilla masters from and deploys into: the Steam install or
a stock game folder.
_Avoid_: data folder (a subpath), install path

**Stock game folder**:
Wabbajack's Stock Game: a copy of the vanilla game files outside Steam's management.
_Avoid_: game copy, vanilla folder
