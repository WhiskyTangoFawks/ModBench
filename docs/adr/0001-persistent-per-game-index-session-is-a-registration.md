---
status: accepted
---

# The index is a persistent per-game database; a session is a registration over it

Decided 2026-08-29, rewriting the 2026-05-31 decision in place (that one — "no cross-session
cache, in-memory DuckDB, rebuild on every load" — named its own expiry: *"if persistent DuckDB is
ever introduced, an mtime or hash strategy can be revisited then"*; this is that revisit). The
incremental-mutation half of the original decision (`AddPlugin`/`CreatePlugin` mutate the live
session, no teardown) stands unchanged and is now the model for everything.

## Context

Profiled on a real 72-plugin / 2.29 M-record load order (#113, The Midnight Ride): a full session
load is 285 s after the per-record pipeline was parallelized (566 s before), and **82% of it is the
vanilla masters and DLCs — files that never change — re-serialized from scratch on every launch**
because the index lives in `DataSource=:memory:` and dies with the process. The first plugin in
any load order is the biggest one, so the tree is unusable for the first ~160 s regardless of
progressive loading. No per-record optimization reaches under a minute; only not redoing the work
does.

Meanwhile the session model has become dynamic (ADR-0035): plugins are enabled, disabled,
reordered, loaded and unloaded while a session is live, and every one of those is already an
in-place mutation of the index (`Index`/`Unindex`/`SetPluginParticipation`/`UpdateWinners`) rather
than a rebuild. xEdit's precedent (`.refcache`, loaded instead of rebuilt) is strictly on-load;
ours has to survive mutation, which is why the answer is not a cache beside the index but the
index itself outliving the process.

## Decision

1. **The DuckDB database is a file, one per game Data install**, under the service's local app
   data (`%LOCALAPPDATA%/mEdit/index/<game>-<hash of Data path>.duckdb`). Every MO2 instance and
   profile on that game shares it; the vanilla masters are indexed once, ever.

2. **The index mirrors file state; a session is built over it.** Two different things happen
   to a plugin and they get two different verbs, never conflated:
   - **A file changes on disk** — created, modified, deleted, uninstalled — and the index
     changes with it: indexed when it appears, re-indexed when its bytes change, its rows
     **removed** when it is gone (`Unindex`). The index holds exactly what exists, nothing a
     file no longer backs. This is what "never assume exclusive ownership" means for an index:
     it is a mirror of the disk, kept true by the checks in point 4, not a record of what
     Modbench once saw.
   - **A session changes** — a plugin is loaded, unloaded, enabled, disabled, reordered — and
     only the *registration* changes. The file did not change, so the rows do not.

   The `plugins` table is the session: a row means "this plugin, from this
   origin, is in the current session, at this `load_order_idx`, participating or not". Loading a
   session registers its plugins; loading, unloading, enabling, disabling and reordering are
   `plugins`-row changes plus the winner sweep. `records` rows for plugins not registered in the
   current session remain in the file and **are invisible to every read** — the read seam and
   every generated `json_extract` view join `plugins`, so the SQL door (user filters,
   `medit.query`) sees exactly what the C# surface sees.

   This amends [ADR-0035](0035-one-plugins-tree-editing-is-a-capability.md)'s *"hidden means
   absent is unloading, never filtering"*: **absent now means unregistered.** The invariant's
   intent — a hidden plugin's records must not answer a query, ever, on any path — is unchanged;
   what changes is that the mechanism is a join on `plugins` rather than the physical absence of
   rows, because physical absence is exactly what makes re-loading cost a full re-index.
   `Unindex` is the file-gone verb — a delete, an uninstall, a file missing at validation —
   never the meaning of unload.

3. **The load order is decoupled from the rows.** A record's identity is `(form_key, origin,
   plugin)` — everything about it is derived from the file it came from, and no session numbering
   is part of it. `load_order_idx` and participation live **only on the `plugins` row** and are
   joined at read; `records.load_order_idx` is dropped. `plugins.txt` is the index the session
   view is built from, and reordering it touches one row per plugin, never a record.

   The one session derivative that stays materialized on `records` is `is_winner`: it is a
   function of the registered load order, recomputed by the winner sweep (2 s on the profiled
   order) whenever registration changes, and it is never a key and never persisted as truth —
   a file-mirror row carrying a cached session answer, labeled as such. Moving it into a
   session-owned table is a later refactor if the sweep's cost or the labeling ever bites.

4. **Validity is by content, never by clock, and it is checked at every door.** `plugins` records
   the content hash of the file each plugin's rows were built from, plus the codec+schema
   version. At session load every registered plugin's file is hashed (a few seconds for 2.3 GB —
   never `mtime`, the trap the 2026-05 cache fell into) and any mismatch re-indexes that plugin
   in place; a codec or reflector version change invalidates the whole file. At runtime,
   `ExternalChangeWatcher` (#417) is extended from tracked binaries to every indexed binary, the
   game's `Data/` included: a debounced change re-hashes and re-indexes through `ReindexPlugin`.
   This is root CLAUDE.md's never-assume-exclusive-ownership rule applied to the index: MO2,
   xEdit, Steam and the user all write these files, and the index detects it rather than trusts
   its last write.

5. **Tracked plugins are always re-ingested from their source tree at load** (`SourceIngest`,
   0.3 s on the profiled order) — the tree is their truth (ADR-0041/0042), and it sidesteps
   persisting working-tree/committed divergence across restarts. Their rows persist like any
   other and are simply replaced.

6. **One writer.** A DuckDB file admits one writing process; a second service instance on the
   same game opens read-only against the last committed state and reports itself as such, or
   waits — never a second file, never silent divergence. A file that cannot be opened (DuckDB
   storage-format change on upgrade, corruption) is rebuilt from scratch: the index is derived
   state and losing it costs one cold load, which is what it costs today.

## Consequences

- Launch of an unchanged load order is dominated by open + hash-validate + register + winner
  sweep, not by indexing: tens of seconds on the profiled order rather than 285.
- Profile switches on the same game re-index only plugins the file has never seen; RAM drops
  (buffer pool instead of a resident 2.3 M-record index).
- Every read path and every generated view must scope by registration — an audit of
  `DuckDbRecordIndex` and `RecordViewBuilder`, and the invariant in `MEditService/CLAUDE.md`
  is reworded from "unloading, never filtering" to "unregistered, never physically present but
  answering".
- New failure surfaces, each with a named answer: stale rows (content hash), format drift
  (version key → rebuild), a second writer (lock → read-only). Disk growth needs no policy of
  its own: the index is bounded by the plugin files that exist, and a file's removal removes
  its rows — at the watcher's delete event while running, at validation on the next open
  otherwise.
- The load-time profile harness (`RealData/SessionLoadProfile`) gains a warm-launch measurement,
  so both numbers — cold index and warm register — stay measured.

## Alternatives rejected

- **A per-plugin Parquet cache beside an in-memory index** (`COPY … TO` on index, `read_parquet`
  on load). Fastest to build and keeps the in-memory model intact, but it is a second store with
  its own writer, reader, key and eviction policy, and every runtime mutation would have to be
  mirrored into it. Rejected on the collapse-over-build rule: the index already has the verbs.
- **Delete unregistered plugins' rows on unload** (keep "absent means unindexed" literally).
  Conflates two events — a session no longer wanting a plugin and the plugin ceasing to exist —
  and makes a profile switch or a re-enable cost a full re-index of the plugin, the exact cost
  this decision exists to remove, for no correctness gain the join does not also give.
- **`mtime`-based validity** (the 2026-05 `SessionCache`). Wrong against files other tools write;
  content hash is cheap enough and is the only check that cannot be fooled by a preserved
  timestamp.
- **Rebuild on every load, optimized** (#91's parallelism, #113's ref-collection fold — both
  landed). Halved the load; cannot reach the target, because the floor is the work itself.
