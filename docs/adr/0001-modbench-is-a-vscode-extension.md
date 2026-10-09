# Modbench is a VS Code extension

The goal is not a new modding tool. It is to use the power tools and workflows a professional developer already uses every day, an IDE with version control and tooling, for modding. So Modbench is a VS Code extension, not a standalone application. That buys, free and open source:

- the bulk of the UI, with every configuration and customization VS Code supports;
- program lifecycle, on Windows and Linux alike;
- a battle-tested base millions of people use daily;
- VS Code's agent framework;
- extensibility through other extensions.

The cost is accepted: it is less user-friendly than a purpose-built application. The target audience is super users and workflows with significant complexity, the kind of work it takes to maintain a large modlist.

## Consequences

- A record is a file to VS Code. A tracked plugin's record is a file in its source tree ([ADR-0006](0006-a-tracked-plugins-truth-is-its-source.md)), and a child record's file is its container's ([ADR-0020](0020-a-child-record-lives-in-its-containers-document.md)). For a file, VS Code builds an editor, undo, history, search, navigation and restore. So the grid is VS Code's editor for the record's file, as the text editor is, and its changes go through that document, never around it. Modbench builds none of those for a record.
- A FormKey is a symbol. Plugin source names every reference by FormKey, and the index knows every record and reference, so the index answers VS Code's language features over the source: definition, references, hover, symbols, completion and diagnostics. mEdit stays one HTTP API, and the features are its client, not a language server.
- The index reads an unsaved document in place of its file, as a language server reads the editor's documents, so the editor and every view beside it agree before a save. A document that is not unsaved is its file, and [ADR-0003](0003-modbench-never-assumes-exclusive-ownership-of-a-file-used-by-another-program.md) vouches for it. A gesture on plugin source is one workspace edit and saves nothing itself: VS Code and the user save, as for any file.

## Alternatives rejected

- A standalone desktop application: every item above is rebuilt from scratch. People have tried to replace the ten-year-old tooling before and failed on exactly that.
- An index over the files alone, with each gesture on plugin source saving what it changed. The editor shows a document the index cannot see, so it and every other view disagree until the save lands, and the save is Modbench's, not the user's or VS Code's.
