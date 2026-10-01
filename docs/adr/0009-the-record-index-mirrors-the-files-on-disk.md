# The record index mirrors the files on disk

The record index holds what the plugin files and the source trees say, and nothing else. It is one DuckDB file per MO2 instance. The active plugins filter its rows and never rebuild them ([ADR-0012](0012-every-plugin-in-the-instance-is-indexed.md)). The vanilla masters never change, so re-indexing them on every launch would be most of a launch, and no per-record speedup gets under a minute; only not redoing the work does.

## Strategic invariants

1. **A file changing and the active plugins changing are two events with two verbs.** When a file appears, changes or disappears, the record index follows it: indexed, re-indexed, or its rows removed. When the active plugins change, no file did, so the rows do not. Every read of a record sees only the active plugins, the SQL door included. Both arrive as state, reconciled whole ([ADR-0013](0013-mod-management-hands-editing-the-load-order.md)).
2. **Nothing load-order-derived is stored on a data row.** A row is the file's fact, keyed `(form_key, origin, plugin)`. The active plugins, their positions and the winners live beside the rows and join at read. Winners are keyed by ref as well as FormKey, because the working tree and HEAD can disagree on who wins.
3. **One index file per instance, inside the instance root.** Plugin identity is `(origin, filename)` ([ADR-0012](0012-every-plugin-in-the-instance-is-indexed.md)) and an origin is a mod folder name, unique only within one instance, so the instance is the only scope the key is valid at; every profile in the instance shares the file. It sits beside MO2's own working files, never inside `mods/`, `profiles/`, `overwrite/` or `downloads/`, which a reinstall or a sweep would take the record index with.
4. **Validity is by content, and every reconcile validates every file.** The index records each file's content hash and the codec and schema version its rows were written under. A hash mismatch re-indexes the plugin, a missing file removes its rows, and a version change invalidates the whole file. This is the ownership rule ([ADR-0003](0003-modbench-never-assumes-exclusive-ownership-of-a-file.md)) applied to the record index.
5. **One writer; a second load of the same instance is refused by name.** DuckDB admits one writing process and Modbench runs one service per VS Code window. A second window on the same instance fails with an error the client can tell apart from a failed reconcile and a stale snapshot. A file that cannot be opened is rebuilt from scratch: the record index is derived state, and losing it costs one cold load.

## Derived tactical observations

- A plugin file's stamp is its size, modification time and change time. A file whose stamp matches its last hash keeps that hash without a read. Change time is in the stamp because tools set modification time. At open, the index hashes every file.
- A tracked plugin's documents validate through git, whose index is already a stamp. While HEAD holds, a document git reports clean has not changed. Only a dirty document is read, and a moved HEAD names what changed.

## Alternatives rejected

- **A per-plugin cache beside an in-memory index.** A second store with its own writer, reader, key and eviction policy, with every runtime mutation copied into it. The index already has the verbs.
- **Drop a plugin's rows when it stops being active.** Conflates the game no longer loading a plugin with the plugin ceasing to exist, and makes a profile switch cost a full re-index, the exact cost this decision removes.
- **A read-only mode, or waiting, for the second window.** A second mode every index-writing path would have to detect, or a hang with no signal. Refusal by name is the honest answer.
