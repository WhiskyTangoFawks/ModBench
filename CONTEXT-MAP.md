# Context Map

The product is **Modbench** — "the modding IDE for VS Code." It surfaces two views, backed by two bounded contexts:

- **Loadout** view → Mod Management context
- **mEdit** view → Editing context

(The repo and editing backend are still named `mEdit`/`MEditService` for historical reasons; "mEdit" now refers specifically to the editor view.)

Each UI surface has a living spec in [docs/specs/](./docs/specs/) — a surface belongs to exactly one context and uses its vocabulary.

## Contexts

- [Editing](./CONTEXT.md) — the **mEdit** view: viewing, comparing, and editing plugin records (FormKeys, override stacks, conflicts). Lives in the C# backend (`MEditService/`) plus the editor webviews. Operates on **plugins** and **records**; deliberately avoids the word "mod."
- [Mod Management](./modbench/src/modmanager/CONTEXT.md) — the **Loadout** view: installing, ordering, enabling, and deploying mods, and locating the game. Lives in the VS Code extension (`modbench/src/modmanager/`). Operates on **mods**, **modlists**, and **files**; deliberately avoids records and FormKeys.

## Relationship

- **Mod Management → Editing**: Mod Management resolves the game directory and produces an ordered set of physical plugin paths for `load-explicit` — plugin *order* comes from the Plugin load order (`plugins.txt`, enabled entries only); each plugin name's *physical file* is resolved via the Mod load order (Modlist priority). Vanilla masters are prepended by the backend, not listed by Mod Management. Editing loads that set and reads/writes the plugin files in place.
- **Process ownership**: the extension owns the Editing backend's lifecycle — it spawns the backend for a session and tears it down. See [ADR-0022](./docs/adr/0022-extension-owns-backend-lifecycle.md).
- **Language boundary**: "mod" is forbidden in Editing and central in Mod Management; "record/FormKey" is central in Editing and absent in Mod Management. The shared boundary object is a **plugin file at a physical path**.
- **Shared vocabulary — "load order" is ambiguous across contexts.** Mod Management's **Mod load order** (Modlist priority, `modlist.txt`, file-level winner) and Editing's **Plugin load order** (`plugins.txt`, record-level winner) are two distinct orderings over related but different things (mods vs. plugin files); say which one you mean. `plugins.txt` itself is owned and written by Mod Management's Plugins tab even though the ordering concept it encodes is consumed by Editing — see each context's `CONTEXT.md`.
