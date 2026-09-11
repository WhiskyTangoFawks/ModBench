# xEdit is the reference for record editing

xEdit has 25 years of refinement against this exact problem domain, and essentially every mEdit
user arrives fluent in it. [The xEdit UX audit](../research/xedit-ux-audit.md) and
[the conflict-model notes](../research/xedit-conflict-model.md) record what it does.

## Strategic invariants

1. **Where xEdit has an answer, mEdit adopts it.** A divergence needs a platform limitation that
   cannot be worked around, or a maintainer ruling, and every divergence is on the register
   below. Nicer, cleaner or more modern is not a reason. Mod Management has no xEdit counterpart
   and follows MO2 ([ADR-0017](0017-mo2-is-the-reference-for-mod-management.md)).
2. **Baseline, not ceiling.** The rule governs replacing xEdit's answers, not adding what xEdit
   never had. An addition is opt-in behind an explicit affordance, the default stays xEdit's, no
   xEdit gesture or meaning is redefined to reach it, and where it overlaps xEdit's ground it
   takes xEdit's vocabulary.
3. **Adopted, as xEdit's source has them:** the gesture model, where click focuses, the keyboard
   acts on the focused cell's model value and double click edits; the compare grid as one tree
   with a slot per plugin at every depth, sorted arrays aligned by key, a complex field edited as
   one value; and the two-axis conflict model, ConflictAll per record and per node, ConflictThis
   per plugin. [The record-editor spec](../specs/medit-record-editor.md) states each surface.
4. **Cite xEdit's definitions; rule the composition yourself.** The TES5Edit clone under
   `references/` carries definitions whose consuming machinery is absent from the clone. A
   definition is a fact about the format. Absent machinery never means it is meaningless, and a
   ruling about how definitions compose is never presented as an xEdit fact. A document says
   which of the two it did.

## Divergence register

Each is a platform limitation or a maintainer ruling. Anything not listed aligns.

1. FormKey editing is a native QuickPick, not xEdit's sorted combo box. Limitation: VS Code hosts
   a searchable thousand-row picker better than a webview can.
2. The extended editor is a VS Code editor tab, not a modeless form. Limitation.
3. The clipboard is written through the extension host, not the webview. Limitation, with no
   visible difference.
4. Tracking, compile and branch UX follows git and VS Code; xEdit has no model for review, revert
   or history ([ADR-0007](0007-plugin-edits-are-git-working-tree-changes.md)). Product difference.
5. Copy as New Record prompts for nothing and never mints a duplicate EditorID: the copy lands
   under a derived EditorID, as the Creation Kit appends to a copy's name, and is renamed in the
   grid. xEdit prompts. Ruling.
6. NoConflict and OnlyOne rows are unpainted, and an expanded struct row is unpainted, so a
   background colour means "something here needs attention"; xEdit tints every row. Ruling.
7. A flags row expands into an in-cell checkbox list, collapsed by default to xEdit's compact
   name summary, where xEdit opens a transient check-combo. Ruling.
8. No left click leaves the record panel. The extended editor opens only from the right-click
   menu, and a string cell's second click, F2 and double click open the inline editor like every
   other scalar. A tab relocates the user where xEdit's modeless editor did not. Ruling.
9. There is no ConflictPriority table. Mutagen abstracts away the raw-binary fields xEdit's
   priorities paper over. Closed, not deferred.

A divergence outside this surface is its own ADR:
[ADR-0008](0008-masters-are-derived-from-content.md).

## Alternatives rejected

- **Left-click is edit.** It left nothing for selection, so a read-only surface had to exist to
  select from; drag consumed the mousedown; bounded-list types were copyable only in immutable
  columns. Every problem was downstream of the anchor, and every one is absent in xEdit.
- **A per-cell array widget per plugin column.** Cross-plugin element comparison was impossible.
- **Element-level writes** (`packages[1]`). Array indices have no stable identity.
- **Double click opens the extended editor**, xEdit's own gesture. On a tab it threw the user out
  of the panel and forced a debounce on every inline string edit.
- **The four-state conflict model.** Cannot drive per-cell colour.
- **Conflict state in SQL.** Cannot produce ConflictThis or tell wins from loses; classification
  runs in C# on documents.
