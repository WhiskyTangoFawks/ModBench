# Vortex is the reference for deployment

Modbench is an editor and a list manager, not a game runner. So deployment follows Vortex, not MO2.
Vortex keeps the deployed mods on disk, and the game and every tool see them however they start.
MO2's virtual file system shows the mods only to a process MO2 launched. Where Vortex has an answer,
Modbench adopts it. Every divergence and omission is recorded in
[vortex.md](../out-of-scope/vortex.md).

## Strategic invariants

1. **Deploy puts the mods into the game install the user names.** The game install is a Steam
   install or a Stock Game. The mods are hardlinks.
2. **Modbench does not own the launch.** Any launch sees the deployed mods: Steam, the executable,
   or a tool that finds the game through the registry.
3. **The game install is the user's.** The user answers for the game version. Isolation from Steam
   is a Stock Game, and the user makes it.
4. **One deployment per game per machine.** The game fixes where it reads `plugins.txt`, so one load
   order is live at a time.

## Alternatives rejected

- **MO2's virtual file system.** It ties deployment to the launch, so Modbench would own every
  launch. The hook breaks some tools, and it is fragile under Wine.
- **A separate deploy folder that Modbench creates.** It isolates `Data`, but not `plugins.txt`, the
  INIs or the saves. Tools find the game through the registry and miss the folder.
- **MO2 deploys, permanently.** Modbench never depends on MO2's runtime
  ([ADR-0002](0002-mod-management-and-editing-are-one-tool.md)).
