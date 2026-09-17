# Modules are layered and call adjacent layers through ports

The picture is [docs/architecture/](../architecture/target-architecture.md): one grid, six rows
for the layers, two columns for the processes, each box a module with its interface and what it
hides. The build enforces the arrows the diagram draws. Architecture words live here; domain words
live in the glossary.

## Strategic invariants

1. **Six layers, and each talks only to the one below.** Front end; driving adapters, the API and
   the watchers on the mEdit side, the views on the Modbench side; the core; the shared kernel both
   sides read; driven adapters; the systems of record. The core knows no path, no table and no
   byte format. A driven adapter decides nothing.
2. **A layer boundary is crossed through a port.** A driving adapter calls the core through the
   gesture's handler. The core reaches a system of record only through a driven adapter. The
   notification channel is one publish port with a transport adapter on each side and a test
   double as the second adapter.
3. **The core is two hexagons.** Commands are every mutation of a system of record, one handler
   per gesture the user names, and the only writers of Source and Plugin. Queries are the only
   readers of the read model. The gesture is the interface.
4. **A command returns applied-or-refusal and what it did.** The carrier is each gesture's own; a
   refusal is returned, never thrown; no command returns state the read side owns.
5. **A driven adapter is one deep module that hides its layout.** The Source repository is the
   only repository, and turning an identity into a path is its work alone. The record index is one
   module, projector and store, and nothing outside it names the store. On the Modbench side, each
   MO2 file's format lives in one kernel module that imports only Node builtins, so the kernel
   could compile as its own project.

## Alternatives rejected

- **Every module knows every other**, the service this replaced: the write path pushed rows into
  the index, queries re-read the source tree, and the load order, index and ingest were one type.
- **An architecture test library or an import-boundaries lint** to hold the layers. Project
  references make the compiler the sweep on both sides: `ProjectReference` between the service's
  csproj files, TypeScript project references between the extension's per-box `tsconfig.json`
  files, each list the arrows the reference view draws.
