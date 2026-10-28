# Scripts

A script is a Python file that I or my agent write to do what an xEdit script does: building a patch plugin, a bulk fix, a pass over the load order. It reads and changes records through mEdit, and nothing else. xEdit decides what a script is for; Mutagen names what it reads and writes ([ADR-0018](../adr/0018-xedit-is-the-reference-for-record-editing.md)). Mod management is a task's or the agent's job, never a script's ([ADR-0021](../adr/0021-agents-reach-modbench-through-one-mcp-server-the-extension-serves.md)).

Each story cites what decides it. A story that cites nothing is owned here.

## Running a script

As a user, I want:

1. `import medit` to work with nothing to install or set up, wherever VS Code's Python tooling runs or reads a script in my window: any terminal, Run and Debug in any console, a notebook cell, and the editor. Cites: Existing tools; Minimal by default
2. A script to reach my window's mEdit, so two windows on two instances never cross.
3. No gesture to run a script, and no selection handed to one. A script selects its records by a query or takes them as arguments. Cites: xedit.md, Apply a script over the selection; Minimal by default

## Reading

As a user, I want:

1. To select records with one SQL SELECT over the record index, as the record filter does, and to get back the rows it selects. Cites: catalog, Record, `filter`
2. To read a copy of a record whole, for the fields the record index does not flatten. Cites: Mutagen's data
3. To find the records that reference a record. Cites: editor-referenced-by.md
4. To name a plugin and a record as my agent does, and a name that means more than one thing to be refused, listing each match. Cites: agent.md, Names, stories 1 and 2; ADR-0012
5. Every field named as plugin source and the record index name it. Cites: Mutagen's data
6. A SELECT to read the records of every plugin the record index holds, each row saying whether its plugin is active, so a script sees the patch plugin it builds before I enable it. The record filter shows only the active plugins. Cites: ADR-0012; Writing, story 4

## Writing

As a user, I want:

1. To create a plugin at the end of the load order, and in it to copy a record as an override or as new, create a record, edit a field and delete a record, as my gestures do. Cites: xEdit; catalog, Plugin and Record
2. Each write to be a working-tree change in the plugin's source, which I review, commit or discard in Source Control. Cites: ADR-0007
3. A script never to write a plugin with no source, and never to build, reorder plugins, or decompile and commit a mod. Those are my gestures. Cites: ADR-0007; ADR-0021
4. A query to see every write the script made before it. Cites: Never silently wrong; ADR-0015
5. A script's writes to reach every view as mine do. Cites: common, A view, story 2; ADR-0015
6. A write to a file I hold unsaved changes in to be refused, naming the file, so my unsaved text never reaches the disk through a script. Cites: Never silently wrong

## Reporting

As a user, I want:

1. A refused write to raise an error naming why, and to write nothing. Cites: ADR-0019; Never silently wrong
2. A refused write to write a line in the Output too, and no notification: my script asked, not me. This is an exception to common, Reporting, row 3. Cites: ADR-0019

## Test seam

- Each read, against mEdit over a fixture instance: what it returns and what it refuses.
- Each write: mEdit writes it; given a refusal, it raises and nothing is written.
- A query after a write returns the written rows.
- A terminal, a debug launch and a notebook kernel of the window import `medit` and reach that window's mEdit.
