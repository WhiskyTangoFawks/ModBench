# Deployment: hardlink

The hardlink type deploys the active profile's load order into the deployment folder: each winning file as a hardlink to its copy in the instance, and the plugin order as the `plugins.txt` the game reads ([ADR-0025](../adr/0025-deployment-is-decoupled-from-the-mod-manager.md)). Its gestures are deploy, purge and move to Overwrite, in [commands.md](commands.md) under Instance. What every view shares is in [common.md](common.md).

Each story cites what decides it. A story that cites nothing is owned here.

## The deployment folder

As a user, I want:

1. To pick the deployment folder in a setting of this machine, one for each instance, which no commit holds. Cites: modlist-repository.md, The repository, story 3
2. Deploy with no deployment folder to be refused, naming the setting. Cites: commands.md, Refuse, do not repair
3. A deployment folder on another volume than the instance to be refused, naming both volumes. A hardlink cannot cross volumes. Cites: commands.md, Refuse, do not repair
4. Any folder to be a deployment folder. Cites: Respect the user
5. Each instance on this machine to keep its own deployment folder, so a deploy or a purge of one instance never touches another's deployment folder.

## Deploy

As a user, I want:

1. Deploy to write the files the game gets, as the Mods tree shows them, Overwrite included, each as a hardlink where the game reads it: under the deployment folder's `Data`, or at its root for a file the mod manager places there. Cites: mods.md, The tree, story 8
2. Deploy to write only what the game gets: no dot file and no `source` folder at a mod's root, and a symlink's target in place of the symlink. Cites: mods.md, The tree, story 9
3. Deploy to make the deployment folder hold the load order, writing only what differs: a file it wrote that the load order does not hold is removed, and a missing or changed one is linked again. Cites: ADR-0025; ADR-0003
4. No vanilla file unless a mod holds it. Cites: GLOSSARY.md, Deployment; GLOSSARY.md, Vanilla
5. No INI and no save of the profile's own. Cites: ADR-0025
6. No gesture to run the game. Cites: ADR-0025; Existing tools
7. Deploy as a task, which fails on each warning that the game gets something the load order does not hold: a file left out because its path holds a file deploy did not write, a file left out because another file the game gets folds to its path, and no `plugins.txt` written. My chain then stops before the game starts. A file deploy renamed to remove, and could not then delete, gives the game nothing to read, so it is named in the Output and does not fail the task. Cites: commands.md, A task is an entry point for a chain; Never silently wrong

## plugins.txt

As a user, I want:

1. On Windows, deploy to write `plugins.txt` where the game reads it, in my Windows user's local application data. Cites: Windows and Linux alike
2. On Windows, a `plugins.txt` there that deploy did not write to be renamed, not replaced, and the report to name its new name, so I can put it back. Cites: ADR-0003; Never silently wrong
3. On Linux, deploy to write `plugins.txt` into the prefix of the non-Steam game in Steam that runs a program in the deployment folder. A `plugins.txt` there that deploy did not write to be renamed, as on Windows. Cites: Windows and Linux alike; ADR-0003; Never silently wrong
4. On Linux, with no such non-Steam game or no prefix yet, deploy to write the files, and the report to say that `plugins.txt` was not written, why, and the page that sets it up. Cites: user-docs.md, The wiki, story 2; Never silently wrong
5. On Windows, the instances of one game to share the one `plugins.txt` the game reads, so the game reads the plugin order of the last deploy. On Linux, each deployment folder's non-Steam game has a prefix of its own, so each instance's `plugins.txt` is its own. Cites: Windows and Linux alike

## Files deploy does not manage

As a user, I want:

1. A file in the deployment folder that deploy did not write to be mine: deploy and purge never delete, overwrite or revert it. A file is deploy's only while it is as deploy wrote it. Cites: ADR-0025; ADR-0003
2. Each file in the deployment folder that deploy does not manage to be a problem in the Problems panel, on that file, while it is there. A deployment folder that is, holds or sits inside the game folder raises none: the game's own files are there, and I picked it. Cites: common.md, Reporting; Respect the user
3. A file the game gets whose path holds a file deploy did not write to be left out, and its problem to name both. Cites: Never silently wrong
4. Each problem to offer move to Overwrite as its quick fix, so the next deploy links it back. Cites: catalog `move to Overwrite`; MO2: Overwrite holds what a program writes

## Purge

As a user, I want:

1. Purge to remove each file deploy wrote that is still as deploy wrote it, and to put back the `plugins.txt` deploy renamed.
