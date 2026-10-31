# Build file

The build file serves [ADR-0027](../adr/0027-a-build-file-builds-a-source-mods-folder-from-its-source-folder.md). Its schema is [build-file-1.schema.json](build-file-1.schema.json).

## Rules the schema cannot state

- No two archives pack one path.

## Who writes it

Modbench writes only the first build file (plugins.md, Decompile and commit, story 3), and never rewrites one.
