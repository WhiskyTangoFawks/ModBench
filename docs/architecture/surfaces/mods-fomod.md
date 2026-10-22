# Mods: the FOMOD installer

The FOMOD installer runs a FOMOD's install steps when install meets one, and lands the files my choices select. Its template is MO2's FOMOD installer ([ADR-0017](../../adr/0017-mo2-is-the-reference-for-mod-management.md)); where it departs, [mo2.md](../../out-of-scope/mo2.md) says why. It is a page in an editor tab (common, A view, story 10). It renders what the installer sends and holds no model of its own ([ADR-0005](../../adr/0005-the-document-is-the-record-model.md)). What install does around it is in [mods.md](mods.md#what-install-does).

Each story cites what decides it. A story that cites nothing is owned here.

## Opening

As a user, I want:

1. Install of a file or folder that holds a FOMOD, a `fomod/ModuleConfig.xml` at its root or inside a folder that wraps the root, to open the installer before anything is written: after the name prompt for a new mod, and after the install target pick for an upgrade. Cites: MO2
2. The tab titled `FOMOD: <module name>`.
3. A FOMOD with no step I can see to show its header and Install alone. Cites: MO2
4. A FOMOD whose installer is a script, with no `ModuleConfig.xml`, to install as a plain copy, as Manual does. Cites: mo2.md, divergence 15

## The header

As a user, I want the module's name, author, version and website from its `fomod/info.xml`, and its header image. Cites: MO2

## Steps

As a user, I want:

1. Only the steps whose conditions hold for the choices I made on the steps before, in the FOMOD's order. Cites: MO2
2. Back, Next and Install. Next reads Install on the last step I can see. Back returns to the step I came from, with my choices kept. Cites: MO2
3. Cancel, or closing the tab, to install nothing. Cites: Esc changes nothing
4. Manual to close the installer and install the files as a plain copy (mods.md, Reporting, story 1). Cites: MO2

## Groups and options

As a user, I want:

1. Each group named, with a radio button for each option when I pick exactly one, the same and a None option when I pick at most one, a check box for each option when I pick any or at least one, and every option checked and locked when the group takes all. Cites: MO2
2. Next refused, naming the group, while a group that needs at least one option has none. Cites: MO2
3. Each option's type worked out from its conditions each time its step shows: Required checked and locked, Recommended checked, Not usable unchecked and disabled, Could be usable marked with a warning. Cites: MO2
4. The option under the pointer, or with focus, to show its description and image beside the groups, and a click on the image to open it larger. Cites: MO2
5. Conditions read as MO2 reads them. A plugin is active when the active profile's `plugins.txt` enables it, inactive when the instance provides it and it is not enabled, and missing otherwise. The game's version is its executable's file version. Cites: MO2
6. The author's defaults on every install, an upgrade included. Modbench keeps no choices: the manifest records the files, never how the installer chose them. Cites: MO2; ADR-0022; Minimal by default

## What Install does

As a user, I want:

1. The required files, the files of the options I chose on the steps I can see, and the files the FOMOD installs on a condition that holds, each at its destination, to land as install lands any mod. Where two of them share a path, the higher priority wins. Cites: MO2
2. A file the FOMOD names and its archive lacks to be named in a confirmation, with Install anyway and Cancel. Cites: MO2
3. A FOMOD whose module dependencies do not hold to say which, and install nothing. Cites: MO2

## Reporting

By [common.md](common.md#reporting). As a user, I want a FOMOD whose `ModuleConfig.xml` cannot be read to install as a plain copy, and mods.md, Reporting, story 1 to say why. Cites: Never silently wrong

## Test seam

- The page, given what the installer sends: the header, the steps, the groups, each option's state, and what each click sends back, with no VS Code.
- Install, given a FOMOD archive and the choices: the files landed, each at its destination.
