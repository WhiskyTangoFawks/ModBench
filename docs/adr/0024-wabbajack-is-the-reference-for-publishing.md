# Wabbajack is the reference for publishing

A publisher's configuration is files in the instance, so a publisher is an implementation behind the Instance adapter, as a mod manager is ([principles](../principles.md): Orthogonality). Wabbajack is the reference for what the user sees of publishing.

## Alternatives rejected

- A publisher as a module beside the Instance adapter. Its configuration is files in the instance, and Vortex keeps its collections inside the mod manager, so it would be a second reader and writer of the instance.
- A publishing format of Modbench's own. Players install with the publisher's tools, so Modbench would maintain a format nobody installs from.
