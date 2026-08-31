---
status: accepted
---

# The index is a persistent per-instance database; a load order is a registration over it

## Context

Profiled on a real 72-plugin / 2.29 M-record load order (The Midnight Ride): a full load order
load is 285 s after the per-record pipeline was parallelized (566 s before), and **82% of it is the
vanilla masters and DLCs — files that never change — re-serialized from scratch on every launch**
because the index lives in `DataSource=:memory:` and dies with the process. The first plugin in
any load order is the biggest one, so the tree is unusable for the first ~160 s regardless of
progressive loading. No per-record optimization reaches under a minute; only not redoing the work
does.

Meanwhile the load order model has become dynamic (ADR-0035): plugins are enabled, disabled,
reordered, loaded and unloaded while a load order is live, and every one of those is already an
in-place mutation of the index (`Index`/`Unindex`/`Register`/`UpdateWinners`) rather
than a rebuild. xEdit's precedent (`.refcache`, loaded instead of rebuilt) is strictly on-load;
ours has to survive mutation, which is why the answer is not a cache beside the index but the
index itself outliving the process.

## Decision

1. **The DuckDB database is a file, one per MO2 instance**, inside the instance root
   (`<instance>/modbench/index.duckdb`). Every profile in that instance shares it, which is what
   keeps a profile switch cheap.

   The instance is the only scope it can live at. Every mirror
   table is keyed `(plugin, origin)` and `origin` is a mod folder *name*
   ([ADR-0036](0036-plugin-identity-is-origin-plus-filename.md)), not a path — unique only within
   one instance. Two instances on the same game that both have a mod folder called
   `Unofficial Patch` holding different builds of `UFO4P.esp` collide on that key: keyed by the Data
   install, one instance's load rehashes the *other's* `file_path`, finds it unchanged, and
   registers (point 3) rather than indexing — reading the other instance's records. The cost of the
   fix is that vanilla masters are indexed once per instance rather than once per game. Accepted:
   instances are rare, profiles are common, and Modbench manages an MO2-style instance and nothing
   else — which is also why `LoadOrderMirror.Reconcile` is the only reconcile there is, and
   the plain-Data-folder path (`plugins.txt` beside the game's own `Data`, every origin the reserved
   Data-directory value) is deleted rather than kept as an alternative: it could name no mod folders,
   so it could key no index.

   Inside the instance root, never inside the content MO2 manages there: not `mods/`, `overwrite/`,
   `profiles/` or `downloads/`, any of which a reinstall, a profile delete or a download sweep would
   take the index with. The instance root itself is MO2's own working directory
   (`ModOrganizer.ini`, `webcache/`), so writing derived state beside those does not violate root
   CLAUDE.md's never-assume-exclusive-ownership rule.

2. **The index mirrors file state; a load order is built over it.** Two different things happen
   to a plugin and they get two different verbs, never conflated:
   - **A file changes on disk** — created, modified, deleted, uninstalled — and the index
     changes with it: indexed when it appears, re-indexed when its bytes change, its rows
     **removed** when it is gone (`Unindex`). The index holds exactly what exists, nothing a
     file no longer backs. This is what "never assume exclusive ownership" means for an index:
     it is a mirror of the disk, kept true by the checks in point 4, not a record of what
     Modbench once saw.
   - **A load order changes** — a plugin is loaded, unloaded, enabled, disabled, reordered — and
     only the *registration* changes. The file did not change, so the rows do not.

   The `registrations` table is the load order and nothing else: a row means "this plugin, from this
   origin, is in the current load order, at this `load_order_idx`, participating or not" — it carries
   no fact about the file the rows came from, which is point 4's `mirror.files`. Per
   [ADR-0044](0044-the-load-order-is-mirrored-not-loaded.md) the table is kept true by
   one reconcile verb over the whole Plugin load order, every physical copy is registered, and
   participation is derived from `enabled`/`winning`/listed rather than stored; every loadout
   gesture is a `registrations`-row change plus the winner sweep. `records` rows for plugins not registered in the
   current load order remain in the file and **are invisible to every read** — the read seam and
   every generated `json_extract` view join `registrations`, so the SQL door (user filters,
   `medit.query`) sees exactly what the C# surface sees.

   This amends [ADR-0035](0035-one-plugins-tree-editing-is-a-capability.md)'s *"hidden means
   absent is unloading, never filtering"*: **absent now means unregistered.** The invariant's
   intent — a hidden plugin's records must not answer a query, ever, on any path — is unchanged;
   what changes is that the mechanism is a join on `registrations` rather than the physical absence of
   rows, because physical absence is exactly what makes re-loading cost a full re-index.
   `Unindex` is the file-gone verb — a delete, an uninstall, a file missing at validation —
   never the meaning of unload.

3. **The load order is decoupled from the rows.** A record's identity is `(form_key, origin,
   plugin)` — everything about it is derived from the file it came from, and no load order numbering
   is part of it. `load_order_idx` and participation live **only on the `registrations` row** and are
   joined at read; `records.load_order_idx` is dropped. `plugins.txt` is the index the load order
   view is built from, and reordering it touches one row per plugin, never a record.

   **Nothing load-order-derived is stored on a data row — `is_winner` included.** A record row is
   the file's fact and only the file's fact. Winners are a function of the registered load order
   and live in a load order-owned derived structure on top of the mirror rows: a `winners` table
   (`(ref, form_key) → (plugin, origin)`) rebuilt by the existing sweep whenever registration
   changes, which the read seam and the generated views join. (DuckDB has no incrementally
   maintained materialized views, so "materialized view" here concretely means that derived
   table.) It is keyed by ref, not by FormKey alone, because Effective and Head genuinely
   disagree: a record the working tree deleted promotes the next plugin down at Effective while
   Head still holds the original — which a single stored flag gets wrong.
   `records_head` therefore joins the same table at its own ref rather than deriving a second
   answer of its own. **The cost of that consolidation is an invalidation obligation, and it is
   part of the decision, not an implementation detail:** a live
   derivation is self-correcting, whereas a swept table is only as fresh as its last sweep —
   so every writer that moves a row into or out of *either* ref's stack must resweep, including
   the ones that leave Effective untouched. If the query side ever needs
   more — per-plugin winner counts, contested-FormKey sets — it is added as further derived
   structure over the mirror data, never as columns on it.

4. **Validity is by content, never by clock, and it is checked at every door.** A `mirror.files`
   row records, per plugin, the file its rows were built from, that file's content hash, and the
   codec+schema version they were written under. That is a **separate table from `registrations`**,
   and deliberately so: `registrations` is the load order, so its rows come and go with every load, unload,
   enable and reorder, while these change only when a *file* does. Putting the hash on the
   registration row would throw it away at the first unregister — which is exactly a profile
   switch, the case this decision exists to make cheap. The index is opened, then validated: every
   file it holds rows for is hashed (a few seconds for 2.3 GB — never `mtime`, which other tools'
   writes can fool), a mismatch or a missing file `Unindex`es that plugin so the load re-indexes it
   in place, and a codec or reflector version change invalidates the whole file. Registrations are
   **not** cleared on open (ADR-0044): they are the last known load order,
   and the first reconcile from Mod Management corrects them. At runtime,
   `ExternalChangeWatcher` watches every indexed binary, the
   game's `Data/` included: a debounced change re-hashes and re-indexes through `ReindexPlugin`.
   This is root CLAUDE.md's never-assume-exclusive-ownership rule applied to the index: MO2,
   xEdit, Steam and the user all write these files, and the index detects it rather than trusts
   its last write.

5. **Tracked plugins are always re-ingested from their source tree at load** (`SourceIngest`,
   0.3 s on the profiled order) — the tree is their truth (ADR-0041/0042), and it sidesteps
   persisting working-tree/committed divergence across restarts. Their rows persist like any
   other and are simply replaced.

6. **One writer; a second load order on the same instance is refused.** A DuckDB file admits one
   writing process, and Modbench runs one service per VS Code window, so two windows on the same
   instance (a second profile, the same folder twice) contend for one file. Two windows on two
   *different* instances of one game do not contend at all.
   The second load fails by name: DuckDB's own lock error is the trigger, surfaced honestly as
   `IndexHeldElsewhereException` ("this instance's index is open in another Modbench window") and
   answered by `PUT /load-order` as `423 Locked` — distinct from a failed reconcile (500) and a
   superseded snapshot (409), so the client can tell the three apart. No read-only mode (a second mode every index-writing path would have to
   detect, for a window that could not edit), no waiting (a hang with no signal), never a second
   file (silent divergence). Concurrent editing of one game from two windows is not a workflow
   the git-native model supports anyway. A file that cannot be opened (DuckDB
   storage-format change on upgrade, corruption) is rebuilt from scratch: the index is derived
   state and losing it costs one cold load, which is what it costs today.

## Consequences

- Launch of an unchanged load order is dominated by open + hash-validate + register + winner
  sweep, not by indexing: tens of seconds on the profiled order rather than 285.
- Profile switches within one instance re-index only plugins the file has never seen; RAM drops
  (buffer pool instead of a resident 2.3 M-record index).
- Every read path and every generated view must scope by registration — an audit of
  `DuckDbRecordIndex` and `RecordViewBuilder`, and the invariant in `MEditService/CLAUDE.md`
  is reworded from "unloading, never filtering" to "unregistered, never physically present but
  answering".
- New failure surfaces, each with a named answer: stale rows (content hash), format drift
  (version key → rebuild), a second writer (refused with a named failure). Disk growth needs no policy of
  its own: the index is bounded by the plugin files that exist, and a file's removal removes
  its rows — at the watcher's delete event while running, at validation on the next open
  otherwise.
- The load-time profile harness (`RealData/LoadOrderProfile`) measures both numbers — cold
  index and warm register — in one run: a cold reconcile against a freshly deleted index
  file, then, dispose and reconcile the identical order again over the file the cold run left.

## Alternatives rejected

- **A per-plugin Parquet cache beside an in-memory index** (`COPY … TO` on index, `read_parquet`
  on load). Fastest to build and keeps the in-memory model intact, but it is a second store with
  its own writer, reader, key and eviction policy, and every runtime mutation would have to be
  mirrored into it. Rejected on the collapse-over-build rule: the index already has the verbs.
- **Delete unregistered plugins' rows on unload** (keep "absent means unindexed" literally).
  Conflates two events — a load order no longer wanting a plugin and the plugin ceasing to exist —
  and makes a profile switch or a re-enable cost a full re-index of the plugin, the exact cost
  this decision exists to remove, for no correctness gain the join does not also give.
- **`mtime`-based validity.** Wrong against files other tools write;
  content hash is cheap enough and is the only check that cannot be fooled by a preserved
  timestamp.
- **Rebuild on every load, optimized** (per-record parallelism, the ref-collection fold — both
  landed). Halved the load; cannot reach the target, because the floor is the work itself.
