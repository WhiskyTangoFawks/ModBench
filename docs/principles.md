# Principles

The maintainer's north star. Order is rank: when two principles pull apart, the higher one wins. Modbench is an IDE for a power user, fluent in VS Code, git and software development.

## Orthogonality
Each module owns one responsibility and hides how it does it behind its boundary. A change to one concern stays inside its module. A game, a mod manager or a deployment model is an implementation behind a boundary, never the shape of the design. Modbench grows by adding an implementation, such as a Vortex load order or MO2's deployment model, and the modules around it stay as they are.

## Minimal by default
One gesture does one thing. A workflow of several gestures is a script, and the user writes it. Messages and prompts speak to a developer and skip what one already knows. Every extra gesture and prompt stands between the user and the work.

## Never silently wrong
The user's picture of their data is never silently wrong. Nothing is dropped, skipped or repaired in silence. A user who trusts a wrong picture makes wrong edits to their modlist.

## Windows and Linux alike
Every feature works natively on Windows and on Linux. Neither is a port of the other, and neither lacks a feature the other has. Where the two differ, as file watching, paths and processes do, the difference stays inside the module that meets it.

## Existing tools
Where VS Code, git or Mutagen already does a job, Modbench uses it. The user already understands VS Code and git, and Mutagen already knows every game's format, so a job they do is one Modbench neither teaches nor maintains.

## Mutagen's data, the reference's behaviour, VS Code's interaction
Mutagen decides the data: the format, what a record holds, and how it is read and written. Modbench uses Mutagen's model as it is. The reference tool decides behaviour: what the user sees, what a gesture does and what it is called. MO2 is the reference for mod management and xEdit for records. VS Code decides interaction: how the user reaches a gesture through keys, menus, navigation and selection. Where a reference tool's habit reaches into the data, Mutagen decides.

## Never break the instance for its owner
Modbench never breaks the instance for the mod manager that made it. Modbench writes each file in place, in its owner's format, and a user switches between Modbench and the mod manager with no conversion.
