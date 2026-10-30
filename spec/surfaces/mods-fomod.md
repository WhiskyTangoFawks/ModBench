# Mods: the FOMOD installer

The FOMOD installer runs a FOMOD's install steps when install meets one, and lands the files my choices select. Its template is MO2's FOMOD installer ([ADR-0017](../adr/0017-mo2-is-the-reference-for-mod-management.md)); where it departs, [mo2.md](../out-of-scope/mo2.md) says why. It is a page in an editor tab (commands.md, Where surfaces live; mo2.md, divergence 14). What install does around it is in [mods.md](mods.md#what-install-does).

Each story cites what decides it. A story that cites nothing is owned here.

## Opening

As a user, I want:

1. Install of a file or folder that holds a FOMOD to open the installer before anything is written: after the name prompt for a new mod, and after the install target pick for an upgrade. Cites: MO2
2. The tab titled `FOMOD: <module name>`.
3. A FOMOD with no step I can see to show its header and Install alone. Cites: MO2
4. A FOMOD whose installer is a script refused, saying why, with Manual. Cites: Windows and Linux alike; mo2.md, divergence 15

## The header

As a user, I want the header MO2's installer shows. Cites: MO2

## Steps

As a user, I want:

1. Only the steps whose conditions hold for the choices I made on the steps before, in the FOMOD's order. Cites: MO2
2. Back and Next. Next reads Install on the last step I can see. Back returns to the step I came from, with my choices kept. Cites: MO2
3. Cancel, Esc, or closing the tab, to install nothing. Cites: Esc changes nothing
4. Manual to close the installer and install the files as a plain copy (mods.md, Reporting, story 1). Cites: mo2.md, divergence 16

## Groups and options

As a user, I want:

1. Each group and each option shown and enforced as MO2's installer shows and enforces them. Cites: MO2
2. The option under the pointer, or with focus, to show its description and image beside the groups, and a click on the image to open it larger. Cites: MO2
3. Conditions read as MO2 reads them. Cites: MO2; mo2.md, divergences 19 and 20
4. The author's defaults on every install, an upgrade included. Modbench keeps no choices: the manifest records the files, never how the installer chose them. Cites: MO2; ADR-0022; Minimal by default

## What Install does

As a user, I want:

1. The files the FOMOD installs for my choices to land as install lands any mod, each where MO2's installer puts it. Cites: MO2
2. An install whose FOMOD names a file missing from what I install refused, naming each file, with Install anyway. Cites: Refuse, do not repair; MO2
3. A FOMOD whose module dependencies do not hold refused, naming which, with Manual. Cites: Refuse, do not repair; MO2

## Reporting

By [common.md](common.md#reporting). As a user, I want a FOMOD whose installer cannot be read refused, naming why, with Manual. Cites: Refuse, do not repair
