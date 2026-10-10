# Agent

The agent is an AI agent I run inside VS Code, in Chat or in its own panel. It works on my instance as it works on any project: it reads and edits files. Modbench gives it what the files cannot: the answers the views show me, and the gestures I run ([ADR-0021](../../adr/0021-agents-reach-modbench-through-one-mcp-server-the-extension-serves.md)). Neither xEdit nor MO2 has an agent, so every story is owned here. What every surface shares is in [common.md](common.md).

Each story cites its source. A story with no source is owned here.

## Any agent

As a user, I want:

1. Every agent I run inside VS Code, in Chat or in its own panel, to reach the same things, with only its standard MCP setup, once. Source: VS Code's interaction; ADR-0021
2. My agent to edit plugin source as files, and to change everything else through the gestures I use. A question the files cannot answer, it asks Modbench. Source: Existing tools; Orthogonality
3. My agent's changes to reach every view as mine do. Source: common, A view, story 2; ADR-0015
4. To approve my agent's Modbench actions as I approve any of its tools, in my agent's own way. Modbench adds no approval and no confirmation of its own. Source: VS Code's interaction; Minimal by default
5. To set the port my agent reaches Modbench on, for each workspace, so two windows on two instances each have their own. A window that cannot take its port says so, and names the setting.
6. My agent to learn Modbench from Modbench: what plugin source holds, how a plugin, a mod and a record are named, and which job is a file edit and which a gesture. I set up nothing to teach it. Source: Minimal by default

## Names

As a user, I want:

1. My agent to name a plugin by its file name, a mod by its name, and a record by its EditorID or FormKey, as the views show them.
2. A name that means more than one thing to be refused, and the refusal to list each match, a plugin with its origin. Nothing is picked for my agent. Source: ADR-0012; Never silently wrong
3. My agent to name several objects in one request, as my selection does. Source: common, A view, story 6

## Records

As a user, I want:

1. My agent to read any record in my load order, tracked or not: each plugin's copy, and the copy that wins. Source: editor.md; editor-conflicts.md
2. My agent to find a record by its EditorID or FormKey, and the records that reference it. Source: plugin-source.md, In the text editor, stories 2 and 4
3. My agent to query the index with one SQL SELECT, as record `filter` does, and to get back the rows it selects. Source: catalog `filter`
4. My agent to edit a tracked plugin by editing its source, so each edit is a working-tree change I review, commit or discard in Source Control. Source: ADR-0007
5. My agent to see the problems I see in the Problems panel for the source it changed. Source: plugin-source.md, In the text editor, story 6
6. My agent never to edit an untracked plugin. Editing needs tracking, for my agent as for me. Source: ADR-0007
7. My agent to open a record in an editor tab, to show me what it found. Source: catalog `open`

## Mod management

As a user, I want:

1. My agent to read my profiles, my mod order, my plugin order, what is enabled, and my downloaded files. Source: toolbox.md; mods.md; plugins.md; downloads.md
2. My agent to read each file order conflict: which mod wins each file, and which files each mod loses, as the Mods view and the conflict table show me. Source: mods.md, The tree, story 8; mods-conflicts.md
3. My agent never to switch my profile. The profile is the context I work in.
4. My agent never to deploy.

## Gestures

As a user, I want:

1. My agent to run each gesture that writes or runs, with the same result as mine, unless a story here closes it. A gesture that edits plugin source, or only changes what I see, is closed unless a story here opens it: my agent edits the files, and my screen is mine. Source: commands.md, Effect; Existing tools
2. My agent's gesture to end when the read model shows it, as mine does, so my agent's next read sees its change. Source: common, A gesture that writes, story 1; ADR-0015
3. My agent never to refresh the instance. The watcher keeps it current. Source: ADR-0015

## Reporting

As a user, I want:

1. A request from my agent that fails or is refused to give my agent the reason, and to write a line in the Output. No notification: my agent asked, not me. This is an exception to common, Reporting, row 3. Source: ADR-0019
2. A request from my agent never to open a picker, a prompt or a confirmation. A request that leaves out an Option is refused, and the refusal names the Option. Source: commands.md, Principles

## Test seam

- Each read, given an instance value or mEdit's answer: what it returns and what it refuses, with no agent.
- Each gesture: given its Argument and every Option, it acts on what it was given, never on the selection, and opens nothing.
- The open gestures: the catalog's `writes` and `runs` rows, less the ones closed here, plus the ones opened here.
