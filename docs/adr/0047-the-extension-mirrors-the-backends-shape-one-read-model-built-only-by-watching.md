---
status: accepted
---

# The extension mirrors the backend's shape: one read model built only by watching

The backend's architecture is
[ADR-0046](0046-ports-and-adapters-with-a-write-side-a-read-side-and-one-way-data-flow.md); this
ADR states the same shape for the extension's Mod Management side, over MO2's files instead of the
plugin files and the source tree.

## Context

MO2's files are a system of record the extension does not own: MO2, xEdit, an installer or the user
rewrites `modlist.txt`, `plugins.txt`, `ModOrganizer.ini`, a `mods/` folder or `overwrite/` at any
moment, with Modbench none the wiser. The extension answered that with a provider per view, each
holding its own cache, its own `invalidate()` and its own watchers over the same files: the Mods
tree, the Plugins tree, the Downloads view and the load-order reconcile each re-read what they
needed when a signal they subscribed to fired.

Two costs followed. A view could hold two facts from two generations — a mod list read before a
`modlist.txt` write and a winner map read after it — because each cache expired on its own signal.
And one user gesture fired several watchers, so an extraction or a purge produced a burst of
re-reads per view rather than one.

The backend had the same problem and answered it in ADR-0046: two systems of record, one read model
over them, rebuilt from them, learning of change only by watching and by a reconcile request. That
answer transfers, and having one architecture on both sides of the HTTP boundary is worth more than
either side's local optimum.

## Decision

1. **One read model over MO2's files: the Instance.** The instance directory's files are the truth.
   The Instance is a materialized view over them, rebuilt from them, never a source of truth, and
   never read by the write side. Everything a view shows on the MO2 side is read from it
   (`modbench/src/modmanager/CONTEXT.md`, *Instance*).

2. **The value is whole and immutable.** The Instance holds one value, replaced whole by each
   recompute. There is no partial update and no per-key invalidation, so a consumer can never hold
   two facts from two generations. Its interface is that value, `subscribe`, `refresh` and a
   sequence; a subscriber is handed the value and the sequence it landed at.

3. **Built only by watching.** The Instance owns every MO2-side watcher. A watcher event, activation
   and `refresh` all run the same whole recompute; `refresh` exists because a watcher event the
   platform never delivered has no other correction. The recompute is debounced once for the model,
   not once per watcher, so a burst spanning several files is one recompute.

4. **Recompute is whole, not incremental.** A full walk of a 764-mod, 15,000-file instance measures
   about 0.1 s, which is what makes whole recompute affordable. Incremental update is refused while
   that holds: it would reintroduce per-key invalidation and with it the two-generations bug.

5. **Watchers are not trusted alone, and a bad read is not a new value.** A read that throws —
   MO2 half-way through rewriting a file — logs and leaves the last value and the last sequence in
   place, so a torn file never empties the trees. The next event or `refresh` corrects it.

6. **Commands write and forget.** A write verb is a surgical edit of one MO2 file and returns
   nothing about state (ADR-0021's write verbs, guarded by the corpus tests). It does not push the
   result into the Instance; the watcher over the file it wrote is how the change comes back. Data
   flows one way here as it does in the backend.

7. **A kernel per file.** Each MO2 file's byte format lives in exactly one module under
   `modmanager/mo2/`, and nothing else in `src/` names a format literal — an AST scan
   (`formatLiteralScan.test.ts`) is the gate. The Instance parses through those modules and reuses
   the winner and participation rules the file conflict index and the load order snapshot already
   implement; it re-derives nothing.

## Consequences

- The views stop owning caches and watchers and become renderers of the value, subscribing for the
  next one. Their `invalidate()` methods and their own watcher registrations go.
- The load-order snapshot Mod Management sends Editing (ADR-0044) is a field of the value rather
  than a separate build, so what the Mods tree shows and what the backend is told come from one
  read of disk.
- A test asserts on a landed value by awaiting past a sequence, never by sleeping; a burst asserts a
  recompute count.
- The game directory, the active profile, the downloads and the deploy state join the same value
  rather than growing a second model beside it.

## Alternatives rejected

- **A cache per view, invalidated per signal** — the state this replaces. Every new fact needs its
  own invalidation rule, and the rules disagree at exactly the moments that matter.
- **Incremental update keyed by the changed path** — the obvious performance answer, refused at
  point 4: the measured cost of a whole walk does not justify the per-key invalidation it would
  bring back. If the walk stops being affordable, this ADR is what gets rewritten.
- **Views read the files directly, with no model** — what a provider-per-view already is. It makes
  the two-generations bug the default rather than an accident.
- **The write side pushes its result into the model** — read-your-writes without the watcher round
  trip, and faster. It gives a Modbench write a different path from MO2's write, so the path that
  matters least is the one that gets tested.
