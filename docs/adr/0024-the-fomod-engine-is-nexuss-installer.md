# The FOMOD engine is Nexus's installer

Modbench runs FOMODs on Nexus's installer, the engine Vortex uses, and writes no engine of its own. It is maintained, and it runs on Windows and Linux alike ([principles](../principles.md): Existing tools).

## Consequences

- It runs XML installers only, so a scripted FOMOD installs as a plain copy.

## Alternatives rejected

- MO2's installer, ported. Its engine lives inside its Qt dialog.
- An engine of Modbench's own. Nexus already maintains one.
