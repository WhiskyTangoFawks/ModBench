# Agent

The agent is an AI agent I run inside VS Code, in Chat or in its own panel. It works on my instance as it works on any project: it reads and edits files. Modbench gives it what the files cannot: the answers the views show me, and the gestures I run ([ADR-0021](../adr/0021-agents-reach-modbench-through-one-mcp-server-the-extension-serves.md)). No reference tool has an agent, so none decides a story here. What every surface shares is in [common.md](common.md).

Each story cites what decides it. A story that cites nothing is owned here.

## Any agent

As a user, I want:

1. Every agent I run inside VS Code to reach the same things, with only its standard MCP setup, once. Cites: VS Code's interaction; ADR-0021
2. My agent to edit plugin source as files, and to change the mod manager's files through the gestures I use (story 6). Modbench blocks no file it can reach. A question the files cannot answer, it asks Modbench. Cites: ADR-0021; Respect the user; Existing tools
3. My agent's changes to reach every view as mine do. Cites: common, A view, story 2; ADR-0015
4. To approve my agent's requests to Modbench as I approve any of its tools, in my agent's own way. Modbench adds no approval of its own. Cites: VS Code's interaction; Minimal by default
5. While an instance is open, Modbench to take one port for my agent, the same in every workspace unless I set another for a workspace, so two windows on two instances each have their own. A window that cannot take its port says so, and names the setting.
6. My agent to learn Modbench from Modbench: what plugin source holds, how each object is named, and which job is a file edit, which a gesture and which a Modbench script. I set up nothing to teach it. Cites: Minimal by default
7. A gesture that would ask me first to refuse my agent's request instead, for each item it would destroy. The refusal lists what the item would lose and names force, and my agent requests it again with force once I approve that in my agent's own way (story 4), as git refuses a checkout over my changes until it is forced. Cites: commands.md, Confirm what destroys; Existing tools
8. My agent to read every state a view shows me, as data, so what I can see it can check. Cites: story 6; Minimal by default
9. My agent to understand each reply clearly, so it works effectively.
10. Each reply to my agent to be concise, so it is token efficient. Cites: Minimal by default; Never silently wrong
11. My agent to read Nexus itself where Nexus needs no key, and to learn from Modbench how. Cites: story 6
12. My agent to learn from Modbench that a FOMOD's choices are mine, so it names only choices I made or gave it to make, and otherwise puts them to me. Cites: story 6
13. My agent to understand that Modbench is modding with software development practice, so that it works as Modbench intends even before I know how Modbench applies that practice. Cites: story 6; Existing tools
14. My agent to understand what Modbench does to the instance automatically, and what follows a change I make by hand, so that a change it did not make does not surprise it. Cites: story 6; ADR-0003; ADR-0015

## Names

As a user, I want:

1. My agent to name an object as the views show it: a plugin by its file name, a mod or a separator by its name, a record by its EditorID or FormKey, a downloaded file by its file name, a file or a folder outside my downloads by its path, and a file in a mod by its path in the mod.
2. A name that means more than one thing to be refused, and the refusal to list each match as my agent can name it: a plugin with its origin, a mod or a separator with which of the two it is. My agent names the one it means as the refusal lists it. Cites: ADR-0012; Never silently wrong
3. My agent to name several objects in one request, as my selection does. Cites: common, A view, story 6

## Records

As a user, I want:

1. My agent to read any record the record index holds, in a compiled plugin or not: each plugin's copy, and the copy that wins. Cites: editor.md; editor-conflicts.md
2. My agent to find a record by its EditorID or FormKey, and the records that reference it. Cites: editor-referenced-by.md; source.md, In the text editor, story 4
3. My agent to query the record index with one SQL SELECT. Cites: scripts.md, Reading, story 1; catalog, Record, `filter`
4. My agent to edit a compiled plugin by editing its source, so each edit is a working-tree change I review, commit or discard in Source Control. Cites: ADR-0007; Any agent, story 2
5. My agent to see the problems I see in the Problems panel for the source it changed. Cites: source.md, In the text editor, story 6
6. My agent never to edit a plugin with no plugin source. Editing needs plugin source, for my agent as for me. Cites: ADR-0007
7. My agent to open a record in an editor tab, to show me what it found. Cites: catalog, Record, `open`
8. My agent to change many records by a rule with a Modbench script, as I do. Cites: scripts.md; ADR-0021
9. My agent to learn from Modbench which SQL views a SELECT reads, and the columns of each. A SELECT that reads anything else is refused, naming the SQL views. Cites: Any agent, story 6
10. My agent's SELECT whose rows outgrow what my agent reads in one reply to be refused, naming a Modbench script as the way to read them all. Cites: scripts.md, Reading, story 1; Any agent, story 10

## Mod management

As a user, I want:

1. My agent to read everything the views show me of my instance. Cites: toolbox.md; mods.md; plugins.md; downloads.md; instance-repository.md, Status
2. My agent to read each file order conflict: which mod wins each file, and which files each mod loses, as the Mods view and the conflict table show me. Cites: mods.md, Indicators; mods-conflicts.md
3. My agent to switch my profile as I do (Gestures, story 1). Cites: Respect the user
4. My agent to deploy, purge and move to Overwrite as I do (Gestures, story 1). Cites: Respect the user
5. My agent to read what the Plugins view shows me under Sorting rules, each with its level and suggested move, and to name a broken rule to apply suggested move as that read lists it. My agent edits the userlist as a file, as I do: it is LOOT's file, not the mod manager's (ADR-0026). Cites: plugins.md, Sorting rules

## Gestures

As a user, I want:

1. My agent to run each gesture whose effect is `writes`, with the same result as mine, except a gesture a story here keeps from it. A gesture whose effect is `edits` or `reads` is kept from my agent unless a story here gives it: my agent edits the files, and my screen is mine. Cites: commands.md, Effect; Existing tools
2. My agent's next read to see the change its gesture made. Cites: commands.md, A gesture that writes ends when the read model shows it; ADR-0015
3. My agent to refresh the instance as I do (story 1). Cites: Respect the user
4. Each gesture my agent runs to be a tool of its own, named for the gesture, so I approve each as I approve any of its tools, and my agent learns its Argument and Options, and their types, from Modbench. Cites: Any agent, story 4; ADR-0021
5. My agent never to log in: logging in hands it my Nexus API key, a secret it never holds. Log out it requests as I do.
6. My agent's install of a FOMOD to name its choices by step, group and option, as the installer shows them. A request whose choices leave a step I would see unanswered, and that does not hand me the installer, is refused. The refusal lists that step's groups, and its options with their descriptions, so my agent can put the step to me, and names the Option that hands me the installer (story 8). Without the installer, the author's defaults answer nothing: my agent names its own choices. A step that needs no pick is answered with none, and my agent may ask for Manual in place of choices. A FOMOD that names a file missing from what it installs is refused, naming each file, and my agent requests it again with install anyway. Cites: Names, story 2; mods-fomod.md, What Install does, story 2
7. My agent's download that names no file to be refused, listing the mod's files as the pick shows them, each as my agent can name it. Cites: Reporting, story 2; downloads.md, Download, story 2
8. My agent's install of a FOMOD, when it asks, to open the installer for me. The request waits until I install or cancel, and tells my agent what landed, or that I cancelled. Cites: Any agent, story 12; Reporting, story 3; mods-fomod.md, Groups and options, story 4

## Reporting

As a user, I want:

1. A request from my agent that fails or is refused, in whole or in part, to give my agent the reason for each item. Cites: common.md, Reporting; ADR-0019
2. A request from my agent never to open a picker, a prompt or a confirmation, except the installer it asks for (Gestures, story 8). A request that leaves out an Option the gesture needs is refused, and the refusal names the Option. Cites: commands.md, The entry point supplies what it knows
3. My agent to get each gesture's outcome, so its next step builds on what landed.
4. A refusal that a gesture clears to name the tool that runs it, as my agent sees it. Cites: Any agent, story 6
5. My agent's request for a gesture that runs long to tell my agent it is still working, so my agent waits for the outcome rather than giving up. Cites: story 3; Usable first
