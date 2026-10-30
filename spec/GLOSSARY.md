Architecture words live in `spec/architecture/`. Verbs live in `spec/surfaces/commands.md`. A word is here only where its usual meaning, in software development or in modding, would mislead; a word that is not here means what it usually means.

# Order
A stack of items that resolve conflicts by override. Mod order and plugin order are its two kinds. Load order combines them.

Avoid: priority

## Mod order
The order of mods. It resolves files.

Avoid: mod priority, mod load order

## Plugin order
The order of plugins, held in `plugins.txt`. It resolves records.

Avoid: plugin load order

## Load order
The mod order and plugin order together. The two files resolve the full stack into a playable game state. Never use it for one half alone.

# Winning / losing
The two ends of an order. A wins over B, B loses to A. The extremes are winning-most and losing-most. Vanilla is losing-most in both orders.

Avoid: high or low priority, top or bottom (view words)

# Sort direction
Whether a view lists winning at the top or at the bottom. It never changes who wins.

Avoid: view order, sort order

# Sorting rule
A statement about a plugin's place in plugin order, or about the plugins it needs or cannot load with. The game states some, and LOOT's masterlist and the instance's userlist state the rest.

Avoid: plugin rule, load-order rule

# LOOT group
LOOT's named set of plugins, placed in plugin order after the LOOT groups it names.

Avoid: separator (a mod entry), category

# Order conflict
Several items in an order provide the same thing. The order decides which one wins. Say which order unless context makes it clear.

Avoid: override (a placement, not a clash)

## File order conflict
An order conflict in mod order: enabled mods provide the same relative file.

Avoid: file conflict, override (a placement, not a clash), higher-priority

## Record order conflict
An order conflict in plugin order: plugins define the same record differently. xEdit's classification is the reference (ADR-0018).

Avoid: record conflict, override (a placement, not a clash)

# Override
An item that wins an order conflict by sitting later in the order than the item it conflicts with. The item is a record or a file.

Avoid: patch (that is a kind of plugin), child (that is a record inside another record)

# Underride
An item that loses an order conflict by sitting earlier in the order than the item it conflicts with. It is the other side of an override. The item is a record or a file.

Avoid: inject, inject-to-master

# Mod
A folder of files, installed as one unit, that overlays the game folder. A mod holds zero or more plugins.

Avoid: plugin, package (that is what a mod is made from)

## Mod separator
A mod entry that groups other mods in the list and holds no files. A mod belongs to its separator whichever way the list is displayed. A separator is not a priority position.

Avoid: LOOT group, category

## Source mod
A mod whose folder is a build artifact: the build writes it from the mod's repository in the source folder and the installation files its manifest names. With a remote, the repository is a submodule of the instance's repository. It follows one git workflow.

Avoid: tracked mod (git's tracked is a file in the index)

# Git workflow
How a source mod uses its `main` branch. The user chooses. Two kinds exist: authored and vendored.

## Authored workflow
A git workflow where `main` is the work itself.

Avoid: custom mod, personal mod

## Vendored workflow
A git workflow where `main` holds the author's releases of the mod. Edits live on the `edit` branch. Its manifest names the author's release it builds from, and the releases are not a git remote.

Avoid: modified mod (a vendored workflow describes where `main` points), upstream (git's word for a branch's remote counterpart)

# Source
Source code: what a build compiles a mod from, in a source mod's repository.

Avoid: source (for a package, a host, or where a file comes from: each has its own word)

## Plugin source
Source that holds a plugin in its deserialized form.

Avoid: source (alone), text mirror, Spriggit tree

# Plugin
An `.esp`, `.esm` or `.esl` file. It holds records. A plugin is not a mod, it is a component of a mod.

Avoid: mod (that is a folder), ESP (that is one of the three extensions)

## Patch plugin
A plugin whose purpose is to override records in another mod's plugin, to fix a bug or resolve a conflict.

Avoid: override (that is a placement), fix plugin, child plugin

## Malformed plugin
A plugin whose bytes depart from what the Creation Kit writes, in a way the game tolerates and Mutagen does not: Mutagen fails to read it, or reads it with loss. It is not a correct plugin that Mutagen mishandles.

Avoid: broken plugin, corrupt plugin

## Overridden plugin
A plugin file that another mod's file of the same name overrides. The game loads the winning file and not this one.

Avoid: plugin copy, duplicate, version, shadowed plugin

## Active plugin
A plugin the game loads: the file mod order resolves its name to, with an enabled `plugins.txt` line or loaded by the game with no line. An overridden plugin is never active, whatever its line says.

Avoid: participating, loaded, registered

## Master Plugin
A plugin that another plugin lists as a dependency. A master loads earlier.

Avoid: parent plugin (an override's plugin is not its child)

## Compiled plugin
A plugin in a source mod that a build compiles from its plugin source, which is its truth.

Avoid: source plugin (that reads as plugin source), tracked plugin (git's tracked is a file in the index)

# Vanilla
The base game's own plugins and files.

Avoid: base game, immutable plugin, stock (except in Stock game folder)

# Record
A plugin's unit of data. Each record has a FormKey.

## Plugin Header record
A record that holds a plugin's own header: author, masters and flags. A header is not an override.

Avoid: TES4 record, plugin metadata

## Container record
A record that owns child records, such as a cell or a worldspace. Its children exist only in a plugin that also carries it.

Avoid: group record

## Child record
A record that belongs to another record's structure, such as a cell in a worldspace, or a record an array field lists that carries its own FormKey. A struct element has no FormKey and is not a child record. An override is never a child of the record it overrides.

Avoid: sub-record, nested record

## Referrer
A record that holds a reference to the record the Referenced By list is about. It is one row in that list, whichever plugins hold the reference.

Avoid: referencing record, back-reference

# Modbench script
A program that reads and changes records through mEdit: Modbench's evolution of the xEdit script.

Avoid: script (alone, for this), xEdit script (for Modbench's)

# Record index
mEdit's searchable copy of every record in every plugin of the instance, derived from the plugins.

Avoid: index (git's index, the downloaded files' index, a plugin's load index)

# FormKey
A record's identity: its origin plugin and its ID inside that plugin. It is not a FormID, which also depends on load position.

Avoid: FormID, record ID

# FormLink
A typed field that holds another record's FormKey. Two data errors exist. A dangling link resolves to no record in an active plugin. A type-mismatched link resolves to a type the field does not permit.

Avoid: missing reference, broken link

# Instance
A mod manager's setup for one game: the mods, profiles and downloaded files it manages, wherever it keeps them.

Avoid: loadout, workspace, profile (that is one part of it)

# Profile
A named configuration of an instance: which mods are enabled, and in what order. One profile is active at a time.

Avoid: session, loadout

# Downloaded file
A mod file the instance keeps with its metadata. Installing it creates a mod, and the file stays.

Avoid: download (as a noun; to download is to fetch a file), archive (that is a BA2 or BSA)

# Game folder
The game installation: the Steam install or a stock game folder.

Avoid: game directory, data folder (that is a subpath), install path

## Stock game folder
A game folder that is Wabbajack's Stock Game: one outside Steam's management.

Avoid: game copy, vanilla folder

# Deployment
A load order written where the game reads it: the mod order's winning files into a folder the user picks, and the plugin order into the game's `plugins.txt`.

Avoid: install (that puts a mod into the instance)

# Deployment folder
The folder the user picks for a deployment's files.

Avoid: deploy folder, output folder, staging folder (that is Vortex's mod store)

# Package
What a folder is made from: an installation file, the game folder, or a source mod's repository at a commit.

Avoid: source (that is source code), archive (that is a BA2 or BSA), provider

# Host
Where a package is fetched from: a site such as Nexus, a store such as Steam, or a git remote's server.

Avoid: repository (MO2's word for a host), source

# Manifest
The one file recording how a folder is made: what it is made from, each package's host when it has one, each of the folder's files, and the steps that build it with the tools they run.

Avoid: record (a plugin's unit of data), recipe, directives

# Publisher
A tool that compiles an instance into the modlist players install, such as Wabbajack, or Vortex through its collections.

Avoid: compiler (one stage of a publisher), installer

# Publisher tag
A publisher's own mark on a mod, or on a path in the instance, that changes what the published modlist ships, such as Wabbajack's Always Enabled or a mod's place in a Vortex collection. The publisher names it and gives it its meaning. A row shows it as a badge.

Avoid: tag (a git tag, a modlist's gallery tag), badge (how a row shows it), flag (a plugin header's flags), rule
