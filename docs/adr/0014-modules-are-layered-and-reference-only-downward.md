# Modules are layered and reference only downward

Each module owns one responsibility and hides how it does it ([principles](../principles.md), *Orthogonality*). So modules sit in layers, and a module references only a lower layer of its column or its column's kernel, as [layers.d2](../architecture/layers.d2) draws. A lower layer reaches an upper one only through a port in the kernel or a watch. The gate enforces the rule: a reference it forbids fails the architecture gate every merge runs. A reference it permits is tactical, decided in the commit that adds it.

## Consequences

- **A write passes through the core; a read takes the shortest path down.** The core holds the rules that refuse a write, so nothing reaches a system of record around it. A read gains nothing from a layer that only passes it on. Commands, one per gesture, are the only writers. Queries is the read model's face, and nothing else reads the Index.
- **A composition root references every box below it and decides nothing.** Code with no obvious home is one box's, or its band's lib, or a stop: the architecture is missing a box.

## Alternatives rejected

- **Every module knows every other:** the write path pushed rows into the index, queries re-read the source tree, and the load order, index and ingest were one type.
- **An architecture test library or an import-boundaries lint** to hold the layers. Project references make the compiler the sweep on both sides: `ProjectReference` between the service's csproj files, TypeScript project references between the extension's per-box `tsconfig.json` files, and a gate holds every list to the rule.
- **A hand-drawn reference list per box, each arrow a ruling:** a reference the rule permitted still stopped the work, so agents copied code and parked logic in the composition root rather than ask.
- **Shared code in the composition root:** helpers that no box owned collected there, and the views imported the module whose job is to import them.
- **A copy of shared mechanics in each box:** a defect fixed in one copy stayed in the others.
