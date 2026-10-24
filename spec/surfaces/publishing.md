# Publishing

Modbench keeps the instance publishable and shows what each publisher will ship ([ADR-0024](../adr/0024-a-publisher-is-an-implementation-behind-the-instance-adapter.md)). What every view shares is in [common.md](common.md).

Each story cites what decides it. A story that cites nothing is owned here.

## Publishers

As a user, I want:

1. Wabbajack as a publisher, while the instance holds its compiler settings, so I maintain the Wabbajack modlist I publish in Modbench. Cites: ADR-0024

## What ships

As a user, I want:

1. Each file Modbench keeps in the instance, such as its record index, the repository's own files and every manifest, to be in the publisher's ignore list, so the published modlist ships none of them. Git init and update manifest keep these entries current, and leave every other entry as I wrote it. Cites: Never break the instance for its owner; Never silently wrong

## Publisher tags

Each publisher declares its publisher tags: each one's name, its badge, and whether it marks paths or only mods. Modbench shows and changes them, and never interprets them. As a user, I want:

1. Each row a publisher tag covers, as its publisher applies it, to carry the publisher tag's indicator: a mod, or a folder or file in one ([mods.md](mods.md), Indicators). Cites: ADR-0024; Never silently wrong
2. Add publisher tag and remove publisher tag on the selected mods, folders and files, with a pick of the publisher tags the publisher declares for those rows. Remove offers only the publisher tags the selection holds.
3. A mod's publisher tags to follow it through rename, and uninstall to remove them, so no publisher tag names a mod that is gone. Cites: Never silently wrong
4. A publisher tag that names no path in the instance shown in the Problems panel, on its line in the publisher's configuration. Cites: Never silently wrong; VS Code's Problems panel
5. Publisher tags read and written in the publisher's current configuration alone.
6. Each publisher tag named with its publisher when the instance has more than one, so two publishers' publisher tags never read as one. Cites: Never silently wrong
