# deploy-mods: contract (draft)

Diagram: [deploy-mods.d2](deploy-mods.d2). Catalog row: `deploy / purge` under Instance in
[commands.md](../commands.md). Governed by
[ADR-0002](../../adr/0002-mod-management-and-editing-are-one-tool.md),
[ADR-0003](../../adr/0003-modbench-never-assumes-exclusive-ownership-of-a-file.md),
[ADR-0016](../../adr/0016-mod-management-lives-in-the-extension.md) and
[ADR-0017](../../adr/0017-mo2-is-the-reference-for-mod-management.md).

Each story cites its source: a principle in [commands.md](../commands.md), an ADR, the catalog or the
diagram. **Ruling** means the maintainer decided it and nothing else states it.

## Shared

As a user, I want:

1. To be asked to confirm every time, before anything is written. *purge follows Confirm what
   destroys; deploy asks too, which is a ruling and an exception to it*
2. Esc on that prompt to leave my game folder untouched. *Esc changes nothing*
3. A failure to leave my game folder as it was, and to tell me why. *A failed gesture writes nothing;
   ADR-0019*
4. Deploy to be a state I hold, not a step of running the game. Nothing purges on its own, not even
   when the game exits, and deploy is not part of `run`. *catalog Meaning*

## deploy

As a user, I want:

1. Deploy offered only when an MO2 instance is open and it is not deployed. *catalog Where and
   Meaning; No dead entries*
2. Deploy to link the mods the way the Mods tree shows them winning. *ruling*
3. No dot files, no root `source` folder and no `.mohidden` files in my game folder. A nested
   `Scripts/Source` still links. *ruling*
4. A symlinked file linked as a hardlink to the real file. A broken link or a cycle skipped and
   logged. A socket or a pipe skipped. *ruling*
5. Deploy to refuse when it would overwrite a file it did not make, naming the file, and to write
   nothing. *ruling: refuse, never silently destroy*

A mod that ships a file with a vanilla name blocks the whole deploy. This is accepted. It comes with
hardlinks, which MO2 does not use.

## purge

As a user, I want:

1. Purge offered only when the instance is deployed. *catalog Meaning ("toggle"); No dead entries*
2. Purge to remove what deploy added, including the manifest, so the instance reads as not deployed.
   *catalog Meaning ("toggle"); the diagram header*

## Test seam

- **The Toolbox:** what is offered, the confirmation, and Esc.
- **The deploy box:** given an Instance value, what it asks MO2 files to write or remove, and what it
  reports.

## Open Questions

1. **What counts as deployed.** The diagram header derives the deploy state from the manifest. Both
   the purge and deploy "offered when" stories rely on it.
2. **What purge does with a file Modbench did not deploy.** No source decides it.
3. **Root folders**, in scope for the alpha and part of deploy. Hardlink or copy, what purge removes
   above `Data`, and whether the confirmation covers it.
4. **Cross-volume and game folder ownership.** Provisionally not supported in the alpha.
5. **A failed purge.** Shared story 3 makes it put back the links it removed. The design session may
   relax that.

All of these wait for the ticket "Deployment: a full design session (purge, game folder ownership,
cross-volume)".
