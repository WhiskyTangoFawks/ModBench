# Edits reach the read model through the watcher

Each process's read model follows its files, never the writer ([ADR-0003](0003-modbench-never-assumes-exclusive-ownership-of-a-file-used-by-another-program.md)), so Modbench's own write comes back through the watcher as another tool's does. The read model re-reads what the watcher's events name, and checks the disk once the events stop, because events are lossy. A lost event then leaves the read model late until the next check, and the check's cost grows with the folders and with the files whose content the read model reads, never with every file in a mod.

## Consequences

- A command returns no state and never reads the read model. It takes its inputs from the files, an unsaved document standing in for its file, because the read model can be a generation behind.
- The instance value is replaced whole, however little a re-read reads, so a consumer never holds two facts from two generations.
- The re-read after an event and the check of the disk are the same code, handed different lists, so the code that catches a lost event runs on every event.
- A steady stream of events delays the check by a bounded time, so a long write never hides a lost event for its whole length.
- A re-read in progress finishes, and the events that arrive during it fold into one more. A re-read that each event cancels never finishes while events keep coming.
- A watcher can lose an event, but never window focus, so window focus checks the disk at once, unless a check already waits.
- At start, the read model checks the disk, because no event reports what changed while it was closed.
- From the first event until the check confirms it, the read model says it may be late ([principles](../principles.md), Never silently wrong).

## Alternatives rejected

- The write side pushes its result into the read model. Faster, but a Modbench write then takes a different path from another tool's, and the path that matters least is the one that gets tested.
- A cache per view, invalidated per signal. Every new fact needs its own invalidation rule, and the rules disagree at exactly the moments that matter.
- A watcher per mod folder in mEdit. A large modlist passes the system's limit on watchers, and two watchers over one tree see two sets of events.
- Trust the watcher to see every change. A lost event leaves the read model wrong in silence.
- Check the whole disk on every event. Its cost grows with the size of the list times the number of events.
- Learn the changes from the operating system's change journal. It needs elevated rights.
