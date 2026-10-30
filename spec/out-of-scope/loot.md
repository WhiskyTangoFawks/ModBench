# LOOT: divergences and omissions

Where LOOT has an answer, the sorting rules adopt it ([ADR-0026](../adr/0026-modbench-checks-the-plugin-order-against-loots-metadata-and-never-sorts-it.md)). This file lists every place they do not.

What LOOT does: [the LOOT research](../../docs/research/loot-integration.md).

## Divergences

| # | Where | Modbench | LOOT | Why |
|---|---|---|---|---|
| 1 | The plugin order | Judged as I have it. Each broken sorting rule shows on its plugin, with a suggested move ([plugins.md](../surfaces/plugins.md), Sorting rules) | Sorted, and the sorted order replaces mine | ADR-0026: the user owns the plugin order. |
| 2 | A broken LOOT group | Shows at Info | Dropped from the sort in silence, when keeping it would make a cycle | Principle: Never silently wrong. |
| 3 | The userlist | One for each instance, in the instance, in git | One for each game on the machine | ADR-0026: git holds the instance, and LOOT's userlist is outside it. |
| 4 | The masterlist | Pinned in the instance. It changes only through update masterlist, as a diff | Fetched again on each run while online | Principle: Never silently wrong. |
| 5 | Editing rules | The userlist is a text file in VS Code. Load after is the one gesture that writes it | Edit Metadata, a panel for each plugin | Principle: Existing tools. VS Code edits text. |

## Omissions

| Gesture | LOOT | Reason |
|---|---|---|
| Sort the plugin order | Sort Plugins; Apply, Discard | An ADR decides it |
| Edit a plugin's requirements, incompatibilities, LOOT group, messages and cleaning data | Edit Metadata | VS Code provides it |
| Edit the LOOT groups | Groups Editor | VS Code provides it |
| Clear user metadata | Clear All User Metadata, Clear Plugin User Metadata | VS Code provides it |
| Copy metadata, content or the plugin order | Copy Metadata, Copy Content, Copy Load Order | VS Code provides it |
| Search and filter the cards | Search, Filters | VS Code provides it |
| Redate plugins | Redate Plugins | Game-specific |
| Set game paths, language and theme | Settings | Standalone application |
