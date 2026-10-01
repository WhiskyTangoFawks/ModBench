# Modules are layered and call adjacent layers through ports

The picture is [docs/architecture/](../architecture/target-architecture.md): one grid, six rows for the layers, two columns for the processes, each box a module with its interface and what it hides. The build enforces the arrows the diagram draws. Architecture words live in `docs/architecture/`. The glossary holds the domain words whose usual meaning would mislead.

## Strategic invariants

1. **Six layers; a write passes through the core, and a read takes the shortest path down.** Front end; driving adapters, the API on the mEdit side, the views on the Modbench side; the core; the shared kernel both sides read; driven adapters; the systems of record. A write reaches a system of record through the core, which holds the rules that refuse it, and then a driven adapter. A read or a change notice skips a layer that would only pass it on. The core knows no path, no table and no byte format. A driven adapter decides nothing.
2. **A layer boundary is crossed through a port.** A driving adapter calls the core through the gesture's handler. The core reaches a system of record only through a driven adapter. The notification channel is one publish port with a transport adapter on each side and a test double as the second adapter.
3. **The core is two hexagons.** Commands are every mutation of a system of record, one handler per gesture the user names, and the only writers of Source and Plugin. Queries are the only readers of the read model. The gesture is the interface.
4. **A command returns applied-or-refusal and what it did.** The carrier is each gesture's own; a refusal is returned, never thrown; no command returns state the read side owns.
5. **A driven adapter is one deep module that hides its layout.** The Source adapter is mEdit's only repository, and turning an identity into a path is its work alone. The record index is one module, projector and store, and nothing outside it names the store. On the Modbench side, the Instance adapter is the instance's repository: each of the mod manager's file formats lives inside its implementation, and the game's `plugins.txt` format lives in one kernel module that imports only Node builtins, so the kernel could compile as its own project.
6. **The boxes of one layer in one column share code through one library of that layer.** The library holds no state and no port. Any I/O comes in as an argument. Only that layer's boxes import it, and it imports none of them. Code moves into it when a second box needs it. The diagram draws the library, with its caption, once it exists.
7. **The composition root only wires.** It builds the boxes and joins them. No box imports it.

## Alternatives rejected

- **Every module knows every other:** the write path pushed rows into the index, queries re-read the source tree, and the load order, index and ingest were one type.
- **An architecture test library or an import-boundaries lint** to hold the layers. Project references make the compiler the sweep on both sides: `ProjectReference` between the service's csproj files, TypeScript project references between the extension's per-box `tsconfig.json` files, each list the arrows the reference view draws.
- **Shared code in the composition root:** helpers that no box owned collected there, and the views imported the module whose job is to import them.
- **A copy of shared mechanics in each box:** a defect fixed in one copy stayed in the others.
