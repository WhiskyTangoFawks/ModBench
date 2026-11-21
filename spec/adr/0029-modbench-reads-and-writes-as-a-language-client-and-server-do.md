# Modbench reads and writes as a language client and server do

mEdit is to Modbench what a language server is to VS Code, and the Instance loader keeps the same rules for the mod manager's files. Modbench has files any program can change, a process that keeps what it derives from them, and views that show it. VS Code already solves that problem with a language client and a language server ([principles](../principles.md), Existing tools).

## Consequences

- The writer finishes its own write. A write that knows its content hands it to the read model as it writes, and a write that cannot know its result reads it back before its gesture ends. The write returns once the read model holds the change, so whatever is asked afterwards sees it, and nothing waits on the watch. The content it hands is the file's content, which [ADR-0003](0003-modbench-never-assumes-exclusive-ownership-of-a-file-used-by-another-program.md) validates as any other.
- The watch is VS Code's own, and it hears every write, Modbench's too. The read model reads again what the watch names, and no more. Where the watch does not reach, Modbench tells the user which folder, and reads it at a check of the disk.
- What no watch can name is read when it is needed: at a check of the disk, and by the gesture that depends on it. Read on every change, it would cost every change.
- A read model tells everything that changed: it names it, or says everything. So nothing above it guesses, and a view has one path for Modbench's write and for another program's.
- A change costs what it changes, whatever the size of the modlist ([principles](../principles.md), Usable first). A read that finds nothing new is no change. Whatever derives from the read model updates from what changed. A view asks again only for what it shows.
- Long work never closes a read model: a change or a read lands while it runs ([principles](../principles.md), Usable first).
- An unsaved document stands in for its file only where Modbench edits the document itself, so the editor and every view beside it agree before a save. The mod manager's files take effect on save, because the mod manager and the game read them from disk. Modbench refuses to write a file that VS Code holds unsaved, since one of the two would overwrite the other.

## Alternatives rejected

- Modbench reads its own write as it reads another program's: it writes the file and learns of it from the files. Every write then waits on a second read, and the watch reports it back as a change. VS Code does not do this: its editor updates its document as it saves, and its git reads again inside the operation.
- mEdit speaks the Language Server Protocol. The protocol's own requests assume a server that knows every symbol. Modbench's symbols and problems meet in the extension, because the mod manager's files stay out of mEdit ([ADR-0013](0013-mod-management-hands-editing-the-load-order.md)). The protocol serves one client, and a Modbench script calls mEdit too. The protocol sends a change as a notification with no answer, where a write here returns once the read model holds it.
