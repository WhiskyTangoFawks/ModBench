# Modules are layered and call adjacent layers through ports

Each module owns one responsibility and hides how it does it ([principles](../principles.md), *Orthogonality*). So modules sit in layers, a module reaches another layer only through a port, and the build enforces the arrows [the diagram](../architecture/target-architecture.md) draws: a reference the diagram does not draw does not compile.

## Consequences

- **A write passes through the core; a read takes the shortest path down.** The core holds the rules that refuse a write, so nothing reaches a system of record around it. A read gains nothing from a layer that only passes it on. Commands, one per gesture, are the only writers. Queries are the only readers of the read model.

## Alternatives rejected

- **Every module knows every other:** the write path pushed rows into the index, queries re-read the source tree, and the load order, index and ingest were one type.
- **An architecture test library or an import-boundaries lint** to hold the layers. Project references make the compiler the sweep on both sides: `ProjectReference` between the service's csproj files, TypeScript project references between the extension's per-box `tsconfig.json` files, each list the arrows the reference view draws.
- **Shared code in the composition root:** helpers that no box owned collected there, and the views imported the module whose job is to import them.
- **A copy of shared mechanics in each box:** a defect fixed in one copy stayed in the others.
