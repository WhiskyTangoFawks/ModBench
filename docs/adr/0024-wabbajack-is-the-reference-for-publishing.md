# Wabbajack is the reference for publishing

Modbench keeps a modlist publishable. A publisher is an implementation behind the Instance adapter, as a mod manager is: its configuration is files in the instance, and for a mod manager such as Vortex it is part of the mod manager. Wabbajack is the first implementation, and the reference for what the user sees of publishing: its tags, their names, and the paths each one covers. Another publisher is a second implementation.

## Consequences

- Modbench reads and writes a publisher's configuration in place, in the publisher's format, so the publisher's own tools still read it.
- Modbench uses a publisher's current form alone. Wabbajack's tags in a mod's metadata notes are what it infers from when the instance has no compiler settings; Modbench neither shows nor writes them.

## Alternatives rejected

- A publisher as a module beside the Instance adapter. Its configuration is files in the instance, and Vortex keeps its collections inside the mod manager, so it would be a second reader and writer of the instance.
- A publishing format of Modbench's own. Players install with the publisher's tools, so Modbench would maintain a format nobody installs from.
