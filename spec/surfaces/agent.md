# Agent

The agent is an AI agent I run inside VS Code, in Chat or in its own panel. It works on my instance as it works on any project: it reads and edits files. Modbench gives it what the files cannot: the answers the views show me, and the gestures I run ([ADR-0021](../adr/0021-agents-reach-modbench-through-one-mcp-server-the-extension-serves.md)). Neither xEdit nor MO2 has an agent, so neither reference tool decides a story here. What every surface shares is in [common.md](common.md).

Each story cites what decides it. A story that cites nothing is owned here.

## Any agent

As a user, I want:

1. Every agent I run inside VS Code, in Chat or in its own panel, to reach the same things, with only its standard MCP setup, once. Cites: VS Code's interaction; ADR-0021
2. My agent to edit plugin source as files, and to change the mod manager's files only through the gestures I use. A question the files cannot answer, it asks Modbench. Cites: Existing tools; Orthogonality
3. My agent's changes to reach every view as mine do. Cites: common, A view, story 2; ADR-0015
4. To approve my agent's requests to Modbench as I approve any of its tools, in my agent's own way. Modbench adds no approval of its own. Cites: VS Code's interaction; Minimal by default
5. While an instance is open, Modbench to take one port for my agent, the same in every workspace unless I set another for a workspace, so two windows on two instances each have their own. A window that cannot take its port says so, and names the setting.
6. My agent to learn Modbench from Modbench: what plugin source holds, how each object is named, and which job is a file edit, which a gesture and which a script. I set up nothing to teach it. Cites: Minimal by default
7. A gesture that would ask me first to refuse my agent's request instead, for each item it would destroy. The refusal lists what the item would lose and names force, and my agent requests it again with force once I approve that in my agent's own way (story 4), as git refuses a checkout over my changes until it is forced. Cites: commands.md, Confirm what destroys; Existing tools

## Names

As a user, I want:

1. My agent to name an object as the views show it: a plugin by its file name, a mod or a separator by its name, a record by its EditorID or FormKey, a downloaded file by its file name, a file or a folder outside my downloads by its path, and a file in a mod by its path in the mod.
2. A name that means more than one thing to be refused, and the refusal to list each match as my agent can name it: a plugin with its origin, a mod or a separator with which of the two it is. Nothing is picked for my agent; it names the one it means as the refusal lists it. Cites: ADR-0012; Never silently wrong
3. My agent to name several objects in one request, as my selection does. Cites: common, A view, story 6

## Records

As a user, I want:

1. My agent to read any record in my load order, in a compiled plugin or not: each plugin's copy, and the copy that wins. Cites: editor.md; editor-conflicts.md
2. My agent to find a record by its EditorID or FormKey, and the records that reference it. Cites: plugin-source.md, In the text editor, stories 2 and 4
3. My agent to query the record index with one SQL SELECT, and to get back the rows it selects, as scripts.md, Reading, story 6 says. Cites: catalog, Record, `filter`
4. My agent to edit a compiled plugin by editing its source, so each edit is a working-tree change I review, commit or discard in Source Control. Cites: ADR-0007
5. My agent to see the problems I see in the Problems panel for the source it changed. Cites: plugin-source.md, In the text editor, story 6
6. My agent never to edit a plugin with no source. Editing needs a source, for my agent as for me. Cites: ADR-0007
7. My agent to open a record in an editor tab, to show me what it found. Cites: catalog, Record, `open`
8. My agent to change many records by a rule with a script, as I do. Cites: scripts.md
9. My agent to learn from Modbench which views a SELECT reads, and the columns of each. A SELECT that reads anything else is refused, naming the views. Cites: Any agent, story 6

## Mod management

As a user, I want:

1. My agent to read my profiles, my mod order, my plugin order, what is enabled, my downloaded files, and each mod's status against its manifest. Cites: toolbox.md; mods.md; plugins.md; downloads.md; modlist-repository.md, Status
2. My agent to read each file order conflict: which mod wins each file, and which files each mod loses, as the Mods view and the conflict table show me. Cites: mods.md, The tree, story 8; mods-conflicts.md
3. My agent never to switch my profile. The profile is the context I work in.
4. My agent never to deploy, purge or move to Overwrite. Deployment writes outside the instance, where my game runs.

## Gestures

As a user, I want:

1. My agent to run each gesture whose effect is `writes`, with the same result as mine, except a gesture a story here keeps from it. A gesture whose effect is `edits` or `reads` is kept from my agent unless a story here gives it: my agent edits the files, and my screen is mine. Cites: commands.md, Effect; Existing tools
2. My agent's request for a gesture to end when the read model shows the gesture, so my agent's next read sees its change. Cites: commands.md, Principles, A gesture that writes ends when the read model shows it; ADR-0015
3. My agent never to refresh the instance. Refresh is my safety net, not how changes arrive. Cites: catalog, Instance, `refresh`
4. Each gesture my agent runs to be a tool of its own, named for the gesture, whose input says the JSON type of its Argument and Options. Cites: VS Code's interaction
5. My agent never to log in or log out. My Nexus API key is mine.
6. My agent's install of a FOMOD to name its choices by step, group and option, as the installer shows them. A request whose choices leave a step I would see unanswered is refused, and the refusal lists that step's groups and options, so my agent answers step by step. Nothing is chosen for it, not even the author's defaults. A step that needs no pick is answered with none, my agent may ask for Manual in place of choices, and the result names each file the FOMOD names and its archive lacks. Cites: Names, story 2; mods-fomod.md

## Reporting

As a user, I want:

1. A request from my agent that fails or is refused, in whole or in part, to give my agent the reason for each item. Cites: common.md, Reporting; ADR-0019
2. A request from my agent never to open a picker, a prompt or a confirmation. A request that leaves out an Option the gesture needs is refused, and the refusal names the Option. Cites: commands.md, Principles
3. My agent to get each gesture's outcome: Reporting, story 1 and Gestures, story 2 need it.
4. A refusal that a gesture clears to name that gesture, such as decompile and commit for a plugin with no source. Cites: Any agent, story 6

## Test seam

- Each read, given an instance value or mEdit's answer: what it returns and what it refuses, with no agent.
- Each gesture: given its Argument and the Options it needs, it acts on what it was given, never on the selection, and opens nothing.
- The gestures my agent runs: the catalog's gestures whose effect is `writes`, less the ones kept from it here, plus the ones given to it here.
- Every tool: each input it advertises says its JSON type.
