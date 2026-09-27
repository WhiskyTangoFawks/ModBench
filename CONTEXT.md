Architecture words live in `docs/architecture/`. Verbs live in `docs/architecture/commands.md`. A
word is here only where its usual meaning, in software development or in modding, would mislead; a
word that is not here means what it usually means.

# Order
A stack of items that resolve conflicts by override. Mod order and plugin order are its two kinds.
Load order combines them.
Avoid: priority

## Mod order
The order of mods. It resolves files.
Avoid: mod priority, mod load order

## Plugin order
The order of plugins, held in `plugins.txt`. It resolves records.
Avoid: plugin load order

## Load order
The mod order and plugin order together. The two files resolve the full stack into a playable game
state. Never use it for one half alone.

# Winning / losing
The two ends of an order. A wins over B, B loses to A. The extremes are winning-most and
losing-most. Vanilla is losing-most in both orders.
Avoid: high or low priority, top or bottom (view words)

# Sort direction
Whether a view lists winning at the top or at the bottom. It never changes who wins.
Avoid: view order, sort order

# Order conflict
Several items in an order provide the same thing. The order decides which one wins. Say which order
unless context makes it clear.
Avoid: override (a placement, not a clash)

## File order conflict
An order conflict in mod order: enabled mods provide the same relative file.
Avoid: file conflict, override (a placement, not a clash), higher-priority

## Record order conflict
An order conflict in plugin order: plugins define the same record differently. xEdit's
classification is the reference (ADR-0018).
Avoid: record conflict, override (a placement, not a clash)

# Override
An item that wins an order conflict by sitting later in the order than the item it conflicts with.
The item is a record or a file.
Avoid: patch (that is a kind of plugin), child (that is a record inside another record)

# Underride
An item that loses an order conflict by sitting earlier in the order than the item it conflicts
with. It is the other side of an override. The item is a record or a file.
Avoid: inject, inject-to-master

# Mod
A folder of files, installed as one unit, that overlays the game folder. A mod holds zero or more
plugins.
Avoid: plugin, package

## Mod separator
A mod entry that groups other mods in the list and holds no files. A mod belongs to its separator
whichever way the list is displayed. A separator is not a priority position.
Avoid: group, category

## Tracked mod
A mod whose folder holds a `.git` repository and the plugin source of its plugins. It follows one
git workflow.

# Git workflow
How a tracked mod uses its `main` branch. The user chooses. Two kinds exist: authored and vendored.

## Authored workflow
A git workflow where `main` is the work itself.
Avoid: custom mod, personal mod

## Vendored workflow
A git workflow where `main` holds the upstream mod's releases. Edits live on the `edit` branch.
Upstream is the author's releases, not a git remote: the repository holds no link to it.
Avoid: modified mod (a vendored workflow describes where `main` points)

# Plugin
An `.esp`, `.esm` or `.esl` file. It holds records. A plugin is not a mod, it is a component of a mod.
Avoid: mod (that is a folder), ESP (that is one of the three extensions)

## Patch plugin
A plugin whose purpose is to override records in another mod's plugin, to fix a bug or resolve a
conflict.
Avoid: override (that is a placement), fix plugin, child plugin

## Malformed plugin
A plugin whose bytes provably depart from what the Creation Kit writes. It is not a correct plugin
that Mutagen mishandles.
Avoid: broken plugin, corrupt plugin

## Overridden plugin
A plugin file that another mod's file of the same name overrides. The game loads the winning file
and not this one.
Avoid: plugin copy, duplicate, version, shadowed plugin

## Master Plugin
A plugin that another plugin lists as a dependency. A master loads earlier.
Avoid: parent plugin (an override's plugin is not its child)

# Plugin source
The deserialized form of a plugin, held in a tracked mod's folder.
Avoid: source, text mirror, Spriggit tree

# Vanilla
The base game's own plugins and files.
Avoid: base game, immutable plugin, stock (except in Stock game folder)

# Record
A plugin's unit of data. Each record has a FormKey.

## Plugin Header record
A record that holds a plugin's own header: author, masters and flags. A header is not an override.
Avoid: TES4 record, plugin metadata

## Container record
A record that owns child records, such as a cell or a worldspace. Its children exist only in a
plugin that also carries it.
Avoid: group record

## Child record
A record that belongs to another record's structure, such as a cell in a worldspace, or a record an
array field lists that carries its own FormKey. A struct element has no FormKey and is not a child
record. An override is never a child of the record it overrides.
Avoid: sub-record, nested record

## Referrer
A record that holds a reference to the record the Referenced By list is about. It is one row in
that list, whichever plugins hold the reference.
Avoid: referencing record, back-reference

# FormKey
A record's identity: its origin plugin and its ID inside that plugin. It is not a FormID, which also
depends on load position.
Avoid: FormID, record ID

# FormLink
A typed field that holds another record's FormKey. Two data errors exist. A dangling link resolves
to no record in the load order. A type-mismatched link resolves to a type the field does not permit.
Avoid: missing reference, broken link

# Instance
A mod manager's setup for one game: the mods, profiles and downloaded files it manages, wherever it
keeps them.
Avoid: loadout, workspace, profile (that is one part of it)

# Profile
A named configuration of an instance: which mods are enabled, and in what order. One profile is
active at a time.
Avoid: session, loadout

# Downloaded file
A mod file the instance keeps with its metadata. Installing it creates a mod, and the file stays.
Avoid: download (as a noun; to download is to fetch a file), archive (that is
a BA2 or BSA), package

# Game folder
The game installation: the Steam install or a stock game folder.
Avoid: game directory, data folder (that is a subpath), install path

## Stock game folder
A game folder that is Wabbajack's Stock Game: a copy of the vanilla game files outside Steam's
management.
Avoid: game copy, vanilla folder
