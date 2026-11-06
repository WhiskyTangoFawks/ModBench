# Symbols

The symbols and the language features that answer for them ([ADR-0028](../adr/0028-a-modding-concept-that-files-name-is-a-symbol.md)).

## The symbols

The symbols a file names today:

| Symbol | Its name | Go to Definition |
|---|---|---|
| Plugin | its file name, with the mod that holds it ([ADR-0012](../adr/0012-index-every-plugin-filter-to-the-active-ones.md)). A file name alone names the copy mod order resolves it to. | selects its row in Plugins |
| Record | its FormKey | as [source.md](source.md), In the text editor, story 1 says |
| Mod | its folder's name | selects its row in Mods |
| Mod separator | its name | none |
| Downloaded file | its file name | none |
| Profile | its name | none |
| Papyrus script | its name | opens its source, or its compiled script when it has no source |

Go to Definition that selects a row is an entry point to the symbol's `go to` ([commands.md](commands.md)).

A hover says what the symbol's row's tooltip says, and with no row or no tooltip, its name. A record's hover is as source.md, In the text editor, story 3 says.

## The features

As a user, I want:

1. Go to Definition on a symbol's name, wherever a file names it, as The symbols says.
2. Find All References on a symbol to list each place a file names it.
3. A hover on a symbol's name, as The symbols says.
4. Go to Symbol in Workspace to find any symbol by its name.
5. Completion, where a file names a symbol, to offer the symbols of that kind.
6. A rename to carry each reference to what it renames, whether I start it from its rename gesture, from Rename Symbol on a symbol that has one, or from the Explorer on a symbol that is a file or folder. The references in plugin source and build files change as edits I can review. Cites: ADR-0028; ADR-0027; formats/build-file.md, Canonical text; Never break the instance for its owner
7. A rename that a reference cannot follow, such as in a plugin with no plugin source, to land, with a warning that names each reference left behind. Cites: ADR-0028; common.md, Reporting
8. A reference to a record that names nothing to be a problem, as source.md, In the text editor, story 6 judges it. Cites: Never silently wrong; common.md, Reporting
9. A rename from the Explorer to land even where its rename gesture would refuse the name, with a warning that says why, since VS Code has already renamed the file. Cites: VS Code; Never silently wrong
10. A reference in a plugin with no plugin source to sit at the record that holds it, and a master at the Plugin Header record of the plugin that lists it.
