# The FOMOD engine is Nexus's installer

Nexus's FOMOD installer, the engine Vortex runs, parses a FOMOD, evaluates its conditions and resolves its files, as a library in the extension. It is the one maintained engine that does all three, on Windows and Linux alike, so Modbench writes the installer's page and the answers the engine asks for, never an engine of its own ([principles](../principles.md): Existing tools; Windows and Linux alike).

## Consequences

- MO2's installer stays the reference for behaviour ([ADR-0017](0017-mo2-is-the-reference-for-mod-management.md)). Where the engine behaves otherwise, the difference is a divergence in [mo2.md](../out-of-scope/mo2.md), or a fix sent upstream.
- The engine runs `ModuleConfig.xml` alone on both platforms, so a scripted FOMOD installs as a plain copy.
- The extension ships a native module for each platform.

## Alternatives rejected

- MO2's installer, ported. Its parsing, conditions and file resolution live inside its Qt dialog, so a port keeps MO2's behaviour and rewrites everything else.
- An engine of Modbench's own. About ten thousand lines across five schema versions, which Nexus already maintains and tests on Windows and Linux.
- The engine's C# build, in mEdit. Install lives in the extension ([ADR-0016](0016-mod-management-lives-in-the-extension.md)), and each step of the wizard would cross the wire.
- Vortex's wizard page. It is built on Vortex's own state store and controls, so only its layout carries over.
