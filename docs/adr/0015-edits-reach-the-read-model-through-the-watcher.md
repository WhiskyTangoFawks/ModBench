# Edits reach the read model through the watcher

Modbench never assumes exclusive ownership of a file ([ADR-0003](0003-modbench-never-assumes-exclusive-ownership-of-a-file-used-by-another-program.md)), so a watcher and validation must exist for every file it reads. Once they exist, Modbench's own write can take the same path as another tool's: a command writes a system of record and returns, and the change comes back to the read model through the watcher. Both processes have that shape. In mEdit the read model is the record index, over the plugin files and the source tree. In Modbench it is the instance value, over the mod manager's files. One architecture on both sides of the HTTP boundary is worth more than either side's local optimum.

## Consequences

- The write side never reads the read model. A command takes its inputs from the files: the source text, the plugins and the schema. A document taken from the read model can be a generation behind.
- Read-your-writes belongs to the read side. A command returns no state. The read model announces what changed and the front end re-reads, so a hand edit and another tool's write reach the screen the same way.
- The instance value is recomputed whole, never patched. A consumer then never holds two facts from two generations.

## Alternatives rejected

- Validate on read, or the write side pushes its result into the read model. Read-your-writes without the watcher round trip, and faster. It gives a Modbench write a different path from another tool's, so the path that matters least is the one that gets tested.
- A cache per view, invalidated per signal. Every new fact needs its own invalidation rule, and the rules disagree at exactly the moments that matter.
- A watcher per mod folder in mEdit. A large modlist passes the system's limit on watchers, and two watchers over one tree see two sets of events.
- Forward the changed paths to mEdit. A wrong or missing path leaves the index wrong in silence; a late signal only delays it.
- Trust the watcher to see every change. Focus is the one signal no watcher can lose.
- Incremental update keyed by the changed path. Brings back per-key invalidation and the two-generations bug.
