# Scripts

A Modbench script is a program, here in Python, that I or my agent write, Modbench's evolution of the xEdit script, to do what an xEdit script does: building a patch plugin, a bulk fix, a pass over the load order. It reads and changes records through mEdit, and nothing else. xEdit decides what a Modbench script is for; Mutagen names what it reads and writes ([ADR-0018](../adr/0018-xedit-is-the-reference-for-record-editing.md)). Mod management is a task's or the agent's job, never a Modbench script's ([ADR-0021](../adr/0021-agents-reach-modbench-through-one-mcp-server-the-extension-serves.md)).

Each story cites what decides it. A story that cites nothing is owned here.

## Running a Modbench script

As a user, I want:

1. `import medit` to work with nothing to install or set up, wherever VS Code's Python tooling runs or reads a Modbench script in my window. Cites: Existing tools; Minimal by default
2. A Modbench script to reach my window's mEdit, so two windows on two instances never cross.
3. No gesture to run a Modbench script, and no selection handed to one. A Modbench script selects its records by a query or takes them as arguments. Cites: xedit.md, Apply a script over the selection; Minimal by default

## Reading

As a user, I want:

1. To select records with one SQL SELECT over the record index, the record filter's query language, and to get back the rows it selects. Cites: catalog, Record, `filter`
2. To read a copy of a record whole, for the fields the record index does not flatten. Cites: Mutagen's data
3. To find the records that reference a record. Cites: editor-referenced-by.md
4. To name a plugin and a record as my agent does. Cites: agent.md, Names, stories 1 and 2; ADR-0012
5. Every field named as plugin source and the record index name it. Cites: Mutagen's data
6. A SELECT to read the records of every plugin the record index holds, each row saying whether its plugin is active, so a Modbench script sees the patch plugin it builds before I enable it. Cites: ADR-0012; Writing, story 4

## Writing

As a user, I want:

1. To create a plugin at the winning end of plugin order, and in it to copy a record as an override or as new, create a record, edit a field and delete a record. Cites: xEdit; catalog, Plugin and Record
2. Each write to be a working-tree change in the plugin's source. Cites: ADR-0007
3. A Modbench script never to write a plugin with no plugin source, and never to build, reorder plugins, or decompile and commit a mod. Those are my gestures. Cites: ADR-0007; ADR-0021
4. A query to see every write the Modbench script made before it. Cites: Never silently wrong; ADR-0015
5. A Modbench script's writes to reach every view. Cites: common, A view, story 2; ADR-0015
6. A write to a file I hold unsaved changes in to be refused, naming the file, so my unsaved text never reaches the disk through a Modbench script. Cites: Never silently wrong

## Reporting

As a user, I want:

1. A refused write to raise an error naming why. Cites: common.md, Reporting; ADR-0019
