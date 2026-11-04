# Symbols

The symbols and the language features that answer for them ([ADR-0028](../adr/0028-a-modding-concept-that-files-name-is-a-symbol.md)).

## The symbols

The symbols a file names today:

| Symbol | Its name |
|---|---|
| Plugin | its file name, with the mod that holds it ([ADR-0012](../adr/0012-index-every-plugin-filter-to-the-active-ones.md)). A file name alone names the copy mod order resolves it to. |
| Record | its FormKey |
| Mod | its folder's name |
| Mod separator | its name |
| Downloaded file | its file name |
| Profile | its name |
| Papyrus script | its name |

## The features

As a user, I want:

1. Go to Definition on a symbol's name, wherever a file names it, to open what it names.
2. Find All References on a symbol to list each place a file names it.
3. A hover on a symbol's name to say what it names.
4. Go to Symbol in Workspace to find any symbol by its name.
5. Completion, where a file names a symbol, to offer the symbols of that kind.
6. A rename to carry each reference to what it renames, whether I start it from its rename gesture, from Rename Symbol on a symbol that has one, or from the Explorer on a symbol that is a file or folder. The references in plugin source and build files change as working-tree changes I can review. Cites: ADR-0028; ADR-0027; formats/build-file.md, Canonical text; Never break the instance for its owner
7. A rename that a reference cannot follow, such as in a plugin with no plugin source, to land, with a warning that names each reference left behind. Cites: ADR-0028; common.md, Reporting
8. A reference that names nothing to be a problem, a FormKey as source.md, In the text editor, story 6 judges it. Cites: Never silently wrong; common.md, Reporting
9. A rename from the Explorer to land even where its rename gesture would refuse the name, with a warning that says why, since VS Code has already renamed the file. Cites: VS Code; Never silently wrong
