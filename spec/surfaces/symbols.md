# Symbols

The symbols and the language features that answer for them ([ADR-0028](../adr/0028-a-modding-concept-that-files-name-is-a-symbol.md)). A symbol gives one answer wherever I ask.

## The symbols

The symbols a file names today:

| Symbol | Its name | Go to Definition |
|---|---|---|
| Plugin | its file name, with the mod that holds it ([ADR-0012](../adr/0012-index-every-plugin-filter-to-the-active-ones.md)). A file name alone names the copy mod order resolves it to, and so does the plugin inside a FormKey. | selects its row in Plugins, or shows its file in the Explorer when Plugins shows no row for it |
| Record | its FormKey | opens it, as [editor.md](editor.md), Opening opens a record given without a plugin |
| Mod | its folder's name | selects its row in Mods, or shows its folder in the Explorer when Mods shows no row for it |
| Mod separator | its name | selects its row in Mods |
| Downloaded file | its file name | selects its row in Downloads |
| Profile | its name | none |
| Papyrus script | its name | opens its source, or its compiled script when it has no source |
| File | its path in the Data folder, naming the copy the game gets ([GLOSSARY.md](../GLOSSARY.md), File order conflict) | shows that copy in the Explorer, inside its archive when it is archived |

Go to Definition is an entry point to the symbol's `go to`, and on a record to `open` ([commands.md](commands.md)).

A hover says what the symbol's row's tooltip says, and with no row or no tooltip, its name. A record's hover shows `EditorID [FormKey]`, the record type, and the plugin whose copy wins ([xedit.md](../out-of-scope/xedit.md), divergence 10).

Every answer for a record reads the active plugins and every compiled plugin (ADR-0012). Go to Symbol in Workspace and completion find a record by its EditorID as well as its FormKey. A field holds a reference only where it is in use: a condition parameter its function does not use holds none ([xedit.md](../out-of-scope/xedit.md), divergence 13). A child record's references are its own. Rename Symbol on a record's FormKey or EditorID is `edit field` on it.

## The features

As a user, I want:

1. Go to Definition on a symbol's name, wherever a file names it, as The symbols says.
2. Find All References on a symbol to list each place a file names it.
3. A hover on a symbol's name, as The symbols says.
4. Go to Symbol in Workspace to find any symbol by its name.
5. Completion, where a file names a symbol, to offer the symbols of that kind.
6. A rename to carry each reference to what it renames, whether I start it from its rename gesture, from Rename Symbol on a symbol that has one, or from the Explorer on a symbol that is a file or folder. The references in plugin source and build files change as edits I can review. Cites: ADR-0028; ADR-0027; formats/build-file.md, Canonical text; Never break the instance for its owner
7. A rename that a reference cannot follow, such as in a plugin with no plugin source, to land, with a warning that names each reference left behind. Cites: ADR-0028; common.md, Reporting
8. A reference that names nothing to be a problem. Cites: Never silently wrong; common.md, Reporting
9. A rename from the Explorer to land even where its rename gesture would refuse the name, with a warning that says why, since VS Code has already renamed the file. Cites: VS Code; Never silently wrong
10. A reference in a plugin with no plugin source to sit at the record that holds it, and a master at the Plugin Header record of the plugin that lists it.
11. `go to` and `referenced by` from the palette, with no symbol in focus, to ask for one as Go to Symbol in Workspace finds it. Cites: commands.md, The entry point supplies what it knows
12. Referenced By on a file that is no symbol to refuse, saying why. Cites: commands.md, Refuse, do not repair

## Menus and keys

| Where | Items, in order |
|---|---|
| Explorer menu, on a file | referenced by |
