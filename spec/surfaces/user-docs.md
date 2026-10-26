# User docs

The user docs are what I read about Modbench outside its views: the README, its landing page on GitHub; the walkthrough, its landing page on VS Code's Welcome page; and the pages in `docs/wiki/`. Each fact lives on one of them, and the others point to it.

Each story cites what decides it. A story that cites nothing is owned here.

## The README

As a user who has not installed Modbench, I want:

1. To learn first what Modbench is: a modding IDE, and a software development tool for modding.
2. To learn next whether it is for me, so I stop reading when it is not. Cites: Minimal by default
4. To learn how working in Modbench differs from modding as I know it, from the modlist down to the record, each set against the tool I use for it now. Cites: Mutagen's data, the reference's behaviour, VS Code's interaction
5. To learn whether I can use it now: its status, the games and platforms it supports, what works and what is planned. Cites: Windows and Linux alike
6. To get it running, then to be handed to the walkthrough for the rest.
7. A pointer to how to contribute, and nothing more of it.
8. To learn that Modbench is VS Code, so the editor, terminal, extensions and agents I already use work on my modlist. Cites: ADR-0001
9. To learn that git holds my modlist and my mods' source, so I commit, diff, branch and merge them. Cites: ADR-0007; ADR-0022
10. To learn that Modbench works on files, because VS Code edits files and git stores them.
11. To learn that a mod is restored from its manifest, because git does not hold gigabytes of binary files. Cites: ADR-0022
12. To learn that a plugin is decompiled into a file for each record and built back, so I edit and review its source and never the plugin in place. Cites: ADR-0006; ADR-0007
13. Each thing I learn about to come with why I would want it.
14. To learn that any language scripts Modbench through its HTTP API, and that Modbench ships a Python API that VS Code runs and debugs, so I script records with tools I already use. Cites: ADR-0004
15. To meet my agent as one feature among the others, never as the headline.

## The walkthrough

As a user, I want:

1. One walkthrough on VS Code's Welcome page that takes me from my mod manager's instance to my first edit: open the instance folder and trust it, the Mods, Plugins and Downloads views, git init, decompile and commit a mod, edit a field, review it in Source Control, build, and connect my agent. Cites: VS Code's interaction
2. The walkthrough to open on its own the first time Modbench activates, and never again unless I open it. Cites: VS Code's interaction
3. Each step to tick when I do what it names. Cites: VS Code's interaction
4. A folder I have not trusted, when it is an instance, to say in Modbench's views that Modbench is off until I trust it, with a link to trust it, and Modbench to start once I do, with no reload. The walkthrough to tell me this before I open the folder. Cites: VS Code's interaction; Never silently wrong

## The wiki

As a user, I want:

1. A page for each job that needs more than a walkthrough step to explain, such as connecting my agent or writing a script, that I read on GitHub as a web page.
2. A page that sets up a deployment folder on Linux: its game added to Steam as a non-Steam game, run by Proton, launched once so Steam makes its prefix. Cites: deployment-hardlink.md, plugins.txt, story 4

## Deferred

What I expect to need and choose not to build yet, each with why.

1. Publishing `docs/wiki/` to the GitHub wiki. GitHub already renders the folder as web pages, and the wiki adds only navigation, which a few pages do not need.
2. How a contributor works: how much of the maintainer's spec-driven workflow a contributor follows. Until then, CONTRIBUTING.md holds how to build and test.
