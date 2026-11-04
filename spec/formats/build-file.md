# Build file

The build file serves [ADR-0027](../adr/0027-a-build-file-builds-a-source-mods-folder-from-its-source-folder.md). Its schema is [build-file-1.schema.json](build-file-1.schema.json).

## Rules the schema cannot state

- No two archives of one step pack or unpack one path.

## Who writes it

Modbench writes only the first build file (plugins.md, Version in git, story 2). After that, it changes one only to carry a rename (symbols.md, The features, story 6).

## Canonical text

Modbench writes the first build file in the manifest's canonical text (manifest.md, Canonical text). After that, the text is its author's, and a rename changes only the names it carries.
