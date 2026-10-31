# Manifest

A manifest restores its folder from its packages ([ADR-0022](../adr/0022-git-versions-how-each-folder-is-made-not-the-folder.md)). Its schema is [manifest-1.schema.json](manifest-1.schema.json).

## Rules the schema cannot state

- No two installation files in one manifest share a name.
- No two paths in one manifest differ only by case, since Windows reads them as one file (principles: Windows and Linux alike).
- A path is the file's own path. A mod manager's mark for an excluded file never appears in it.
- Each path in `exclude` is a key of `files`, or a folder above one.

## Who writes it

Modbench writes every manifest (modlist-repository.md, Update manifest; mods.md, Build; plugins.md, Decompile and commit). No gesture asks the user to edit one.

## Canonical text

- The text is UTF-8, with LF at the end of each line, the last line included.
- The members of each object follow the schema's order, such as `version`, `packages`, `exclude`, `files`. An empty member is left out.
- Each package, each path in `exclude` and each file sits on a line of its own. No space sits outside a string, and each string is as `JSON.stringify` writes it.
- Packages follow the schema's order of kinds. Installation files sort by name, and paths sort by path, both in one order: first with each UTF-16 code unit upper-cased where its upper case is one code unit, then as written, both compared by UTF-16 code unit.

```json
{
"version":1,
"packages":[
{"kind":"installationFile","name":"Accessible Bridges-74189-1-3.7z","size":1736415,"hash":"2xdzlSxY/4k=","host":{"nexus":{"game":"fallout4","mod":74189,"file":371740}}}
],
"files":{
"AccessibleBridges.esp":"Qm9yZGVyczE="
}
}
```
