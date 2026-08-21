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

- **Mod Management → Editing**: Mod Management resolves the game directory and produces an ordered set of physical plugin paths for `load-explicit` — plugin *order* comes from the Plugin override order (`plugins.txt`) — **every line, enabled and disabled alike** since [#270](https://github.com/WhiskyTangoFawks/ModBench/issues/270) / ADR-0035, with the `*` prefix travelling as each plugin's **participation** (whether it competes for winner) rather than deciding whether it is loaded at all; each plugin name's *physical file* is resolved via the Mod override order (Modlist priority). Vanilla masters are prepended by the backend, not listed by Mod Management. Editing loads that set and reads/writes the plugin files in place.
- **Process ownership**: the extension owns the Editing backend's lifecycle — it spawns the backend for a session and tears it down. See [ADR-0022](./docs/adr/0022-extension-owns-backend-lifecycle.md).
- **Language boundary**: "mod" is forbidden in Editing and central in Mod Management; "record/FormKey" is central in Editing and absent in Mod Management. The shared boundary object is a **plugin file at a physical path**.
- **Tracking is Editing-internal; nothing new crosses the boundary**
  ([ADR-0041](./docs/adr/0041-manual-git-tracking-compile-from-text.md), superseding
  ADR-0040's provenance-payload amendment): a tracked mod is one whose folder contains
  a `.git` repository, created by an explicit user Track gesture and operated entirely
  by Editing (repos, branches, commits, compile — Mod Management never touches git,
  never calls the backend, and never learns the source exists). The boundary object
  remains exactly origin + physical plugin path (ADR-0036); no provenance payload, repo,
  or ref identifier crosses. Everything the backend knows about external change it
  learns by *observation* at its own touch points (load-time hash check, the bridge
  watcher) — required by the never-assume-exclusive-ownership rule, since MO2, xEdit,
  or the user can install, update, or delete any mod outside Modbench. Source-derived
  state reaches Loadout surfaces only as data through composition roots (the
  `PluginsTreeComposite` pattern), never via a Mod Management→backend call.
- **Shared vocabulary — override order, winning vs losing.** Every conflict is decided by an **override order**, whose ends are the **winning** and **losing** ends — never by position in a file or a view (that is *view order*, a separate configurable presentation choice). There are two distinct override orders: Mod Management's **Mod override order** (Modlist priority, `modlist.txt`, file-level winner) and Editing's **Plugin override order** / Plugin load order (`plugins.txt`, record-level winner). Say which one you mean, and never say "higher/lower priority" — say winning/losing. Anchor invariant: **vanilla content is losing-most on both axes** (`Fallout4.esm` records, vanilla `Data/` files lose to everything). `plugins.txt` itself is owned and written by Mod Management's Plugins tab even though the ordering concept it encodes is consumed by Editing — see each context's `CONTEXT.md`.
