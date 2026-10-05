# A record's editor is VS Code's editor for its source file

A tracked plugin's record is a file in its source tree ([ADR-0006](0006-a-tracked-plugins-truth-is-its-source.md)), and a record opens as that file: the grid is VS Code's editor for it, as the text editor is. Every feature the workbench builds for a file, search, history, navigation, undo and restore, then works on a record, and Modbench maintains none of it ([principles](../principles.md), Existing tools; [ADR-0001](0001-modbench-is-a-vscode-extension.md)).

## Consequences

- The grid's document is never left unsaved. A gesture ends when the read model shows it, and the read model reads the file, never the editor's buffer ([ADR-0015](0015-edits-reach-the-read-model-through-the-watcher.md)). So a change in the grid, an undo included, is on disk before the gesture ends.
- The grid's change goes through the document, never around it. A write to the file behind the editor reloads the editor and discards its undo. So mEdit offers the edit it computes without the write, and the editor applies it. Trees and scripts write through mEdit's commands; only the open document takes the document's path.
- An untracked plugin's record opens read-only, as a document mEdit renders from the plugin. It has no file ([ADR-0007](0007-plugin-edits-are-git-working-tree-changes.md)), and the grid stays one editor for every record.

## Alternatives rejected

- A webview panel with an identity of its own. Every workbench feature it wants is rebuilt: tab restore, history, navigation and undo, and file search never reaches it.
- An editor with a document model of its own over the same file. Tab identity comes back, and undo, dirty state and reload are Modbench's to build.
- The grid writes through mEdit and reloads the file. The integration holds, and undo does not: every reload empties it.
- The read model indexes the editor's buffer. Read-your-writes without a save, and a second door into the read model, which ADR-0015 closes.
