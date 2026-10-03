# MO2 is the reference for mod management

Modbench reconstructs Mod Organizer 2's workflow with VS Code's own UI conventions. Where MO2 has an answer to what the user sees and does, Mod Management adopts it, and every divergence and omission is recorded in [mo2.md](../out-of-scope/mo2.md). It adopts MO2's workflows, not its file formats: MO2 is one mod manager behind the Instance adapter, and another, such as Vortex, is a second implementation. The rule does not govern record editing, which follows xEdit ([ADR-0018](0018-xedit-is-the-reference-for-record-editing.md)), or deployment, a boundary of its own.

## Alternatives rejected

- **Two containers by default, Downloads in the aux bar, for literal MO2 parity.** Claims the space reserved for chat.
- **A custom webview tab-switcher mimicking MO2's three-tab panel.** Reinvents widgets VS Code provides natively; the point is leaning on the platform, not rebuilding MO2's chrome.
- **Downloads as an editor-tab webview.** The richer per-item meta a tab's width could show turned out to be four columns behind a native context menu, nothing a tree cannot show.
- **Two Plugins trees, one per bounded context.** Kept the load order apart from the record browser to avoid conflating the contexts. Both objections are answered structurally: the tree works with no backend, and a plugin's identity, `(origin, filename)` ([ADR-0012](0012-index-every-plugin-filter-to-the-active-ones.md)), keeps the contexts apart.
