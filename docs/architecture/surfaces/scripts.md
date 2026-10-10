# Scripts

A script is a Python file that I or my agent write to do what an xEdit script does: a patcher, a bulk fix, a pass over the load order. It reads and changes records through mEdit, and nothing else. xEdit decides what a script is for; Mutagen names what it reads and writes ([ADR-0018](../../adr/0018-xedit-is-the-reference-for-record-editing.md)). A job that changes the mod manager's files is a task or the agent's, never a script's ([ADR-0021](../../adr/0021-agents-reach-modbench-through-one-mcp-server-the-extension-serves.md)).

Each story cites its source. A story with no source is owned here.

## Running a script

As a user, I want:

1. To run a script from any terminal of my window, or with VS Code's Python Run and Debug, with `import medit` and nothing to install or set up. Source: Existing tools; Minimal by default
2. A script to reach my window's mEdit, so two windows on two instances never cross.
3. My agent to run a script it writes the same way, with nothing I set up. Source: agent.md, Any agent, story 6
4. No gesture to run a script, and no selection handed to one. A script selects its records by a query or takes them as arguments. Source: xedit.md, Apply a script over the selection; Minimal by default

## Reading

As a user, I want:

1. To select records with one SQL SELECT over the index, as the record filter does, and to get back the rows it selects. Source: catalog, Record, `filter`
2. To read a copy of a record whole, for the fields the index does not flatten. Source: Mutagen's data
3. To find the records that reference a record. Source: editor-referenced-by.md
4. To name a plugin and a record as my agent does, and a name that means more than one thing to be refused, listing each match. Source: agent.md, Names, stories 1 and 2; ADR-0012
5. Every field named as plugin source and the index name it. Source: Mutagen's data

## Writing

As a user, I want:

1. To create a plugin, and in it to copy a record as an override or as new, create a record, edit a field and delete a record, as the record panel's gestures do. Source: xEdit; catalog, Record
2. Each write to be a working-tree change in the plugin's source, which I review, commit or discard in Source Control. Source: ADR-0007
3. A script never to write an untracked plugin, and never to track, compile or change the load order. Those are my gestures. Source: ADR-0007; commands.md
4. A query to see every write the script made before it. Source: Never silently wrong; ADR-0015
5. A script's writes to reach every view as mine do. Source: common, A view, story 2; ADR-0015
6. A write to a file I hold unsaved changes in to meet VS Code's own handling of a file changed on disk. Source: ADR-0003; Existing tools

## Reporting

As a user, I want:

1. A refused write to raise an error naming why, and to write nothing. Source: ADR-0019; Never silently wrong
2. A script's output and errors only in its terminal or Debug Console. Modbench adds no notification and no line in the Output: I ran a script, not a gesture. Source: Existing tools

## Test seam

- Each read, against mEdit over a fixture instance: what it returns and what it refuses.
- Each write: given mEdit's changes, it applies every one in order; given a refusal, it raises and writes nothing.
- A query after a write returns the written rows.
- A terminal of the window imports `medit` and reaches that window's mEdit.
