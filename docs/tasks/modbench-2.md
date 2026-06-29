# Modbench-2 — Mod list core

**Status: Not Started**

A working MO2-compatible mod list — read an instance, show it, toggle and reorder mods, writing MO2 format back. No conflict detection, no deploy, no editor coupling yet.

Spec: [mod-manager.md](../mod-manager.md) ("Modlist format & source adapters", "Mod List Tree", Feature Specs §2–3). UI: [modmanager/docs/UI_SPEC.md](../../medit-vscode/src/modmanager/docs/UI_SPEC.md). Architecture: [ADR-0021](../adr/0021-mod-manager-in-extension.md), [MM ADR-0001](../../medit-vscode/src/modmanager/docs/adr/0001-mo2-native-modlist-format.md).

All work is extension-side (`medit-vscode/src/modmanager/`); it is file/JSON work and never parses plugin binaries.

---

## Sub-phases

| Phase | Goal | Model | Est. |
| ----- | ---- | ----- | ---- |
| [2.1](modbench-2.1.md) ✅ | **Data foundation** — `IModlistSource`, MO2 adapter (byte-faithful round-trip), serialization tests. *(Workspace root = MO2 instance; no new game-path config. Native adapter deferred — see below.)* | Opus 4.8 | ~3 days |
| [2.2](modbench-2.2.md) | **Tree UI & core interactions** — `ModListProvider` (separators + ungrouped root items + checkboxes + tooltips), enable/disable, profile selector, header buttons | Opus 4.8 | ~4 days |
| [2.3](modbench-2.3.md) | **Drag, filter & context menus** — `TreeDragAndDropController` (mod + separator block), live filter with grouping toggle, all mod/separator context menu actions | Sonnet 4.6 | ~3 days |

2.1 → 2.2 → 2.3 sequentially. Each phase is independently deliverable and testable.

---

## Deferred (out of 2.1)

- **Native adapter** — creating a *fresh, empty* MO2-format instance from scratch (for users without an existing MO2 folder). The 2.1 workflow opens an existing MO2 folder, so nothing exercises fresh-instance creation. Scope it when a "New instance" feature is actually wanted.

---

## Open question — resolved in 2.1

MO2 round-trip fidelity is proven against a **trimmed-real** fixture captured from the LitR instance (committed under `medit-vscode/src/modmanager/test/fixtures/mo2-instance/`), with the full real LitR instance backing an opt-in test. The full `modlist.txt` is intentionally *not* committed.
