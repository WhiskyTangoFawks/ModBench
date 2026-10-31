# Formats

A format is a file that one machine, or one version of Modbench, writes and another reads. Each format has a schema, `<name>-<version>.schema.json`, and a document, `<name>.md`.

## What earns a sentence

A sentence earns its place when a file one machine or version writes must read the same on another. Anything else is a tactic, and lives in the code.

- The schema holds every rule that JSON Schema can state. Each property's `description` says what its value means.
- The document holds what the schema cannot: a rule JSON Schema cannot state, who writes the file, and its canonical text.
- The document never restates the schema.

## Versions

A file names its format's version in its `version` member. Modbench reads only the version it writes. It refuses a file of another version, and names both versions.

## Canonical text

Each document defines one canonical text. Modbench writes only that text, so the same content is the same bytes on every machine, and a diff holds only a change (modlist-repository.md, The manifest, story 2). Modbench reads any text the schema accepts.
