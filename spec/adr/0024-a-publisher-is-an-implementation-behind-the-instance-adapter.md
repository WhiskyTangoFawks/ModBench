# A publisher is an implementation behind the Instance adapter

A publisher's configuration is files in the instance, so a publisher is an implementation behind the Instance adapter, as a mod manager is ([principles](../principles.md): Orthogonality).

## Consequences

- Modbench edits a publisher's configuration in place, and the publisher compiles. Modbench never builds a modlist itself.
- The Instance adapter stays the one reader and writer of the instance's files.
- A new publisher is a new implementation, and nothing above the adapter changes. A mod manager that holds its own publisher, as Vortex does, is one implementation of both.

## Alternatives rejected

- A publisher as a module beside the Instance adapter. Its configuration is files in the instance, and Vortex keeps its collections inside the mod manager, so it would be a second reader and writer of the instance.
- A publishing format of Modbench's own. Players install with the publisher's tools, so Modbench would maintain a format nobody installs from.
