# Wabbajack is the reference for publishing

A publisher is an implementation behind the Instance adapter, as a mod manager is: its configuration is files in the instance, and for a mod manager such as Vortex it is part of the mod manager ([principles](../principles.md): Orthogonality). Wabbajack is the first implementation, and the reference for what the user sees of publishing: its tags, their names, and the paths each one covers ([principles](../principles.md): Mutagen's data, the reference's behaviour, VS Code's interaction). Another publisher is a second implementation.

## Consequences

- Modbench reads and writes a publisher's configuration in place, in the publisher's format ([principles](../principles.md): Never break the instance for its owner).
- Modbench uses a publisher's current form alone. Wabbajack's deprecated tags in a mod's metadata notes are what it infers its configuration from when the instance has none; Modbench neither shows nor writes them.

## Alternatives rejected

- A publisher as a module beside the Instance adapter. Its configuration is files in the instance, and Vortex keeps its collections inside the mod manager, so it would be a second reader and writer of the instance.
- A publishing format of Modbench's own. Players install with the publisher's tools, so Modbench would maintain a format nobody installs from.
