# xEdit is the reference for record editing

xEdit has 25 years of refinement against this exact problem domain, and essentially every mEdit
user arrives fluent in it. [The xEdit UX audit](../research/xedit-ux-audit.md) and
[the conflict-model notes](../research/xedit-conflict-model.md) record what it does.

## Strategic invariants

1. **xEdit decides what, VS Code decides how.** Where xEdit has an answer for what a record shows,
   what a gesture does and what it is called, mEdit adopts it. How the user reaches a gesture
   (keys, navigation, tabs, menus and selection) follows VS Code. A departure from xEdit's what
   needs a platform limitation or a maintainer ruling, and is on
   [the register](../out-of-scope/xedit.md). Nicer, cleaner or more modern is not a reason. An
   xEdit gesture that VS Code already provides, or that only repeats another, is an omission on
   the register. Mod Management has no xEdit counterpart and follows MO2
   ([ADR-0017](0017-mo2-is-the-reference-for-mod-management.md)).
2. **Baseline, not ceiling.** The rule governs replacing xEdit's answers, not adding what xEdit
   never had. An addition is opt-in behind an explicit affordance, the default stays xEdit's, no
   xEdit gesture or meaning is redefined to reach it, and where it overlaps xEdit's ground it
   takes xEdit's vocabulary.
3. **Adopted, as xEdit's source has them:** the gesture model, where click focuses, the keyboard
   acts on the focused cell's model value and double click edits; the compare grid as one tree
   with a slot per plugin at every depth, sorted arrays aligned by key, a complex field edited as
   one value; and the two-axis record order conflict model, ConflictAll per record and per node, ConflictThis
   per plugin. [The record-editor spec](../specs/medit-record-editor.md) states each surface.
4. **Cite xEdit's definitions; rule the composition yourself.** The TES5Edit clone under
   `references/` carries definitions whose consuming machinery is absent from the clone. A
   definition is a fact about the format. Absent machinery never means it is meaningless, and a
   ruling about how definitions compose is never presented as an xEdit fact. A document says
   which of the two it did.

## Divergence register

[xedit.md](../out-of-scope/xedit.md) lists every divergence and every omission, with the reason for each.
A divergence outside this surface is its own ADR: [ADR-0008](0008-masters-are-derived-from-content.md).

## Alternatives rejected

- **Left-click is edit.** It left nothing for selection, so a read-only surface had to exist to
  select from; drag consumed the mousedown; bounded-list types were copyable only in immutable
  columns. Every problem was downstream of the anchor, and every one is absent in xEdit.
- **A per-cell array widget per plugin column.** Cross-plugin element comparison was impossible.
- **Element-level writes** (`packages[1]`). Array indices have no stable identity.
- **Double click opens the extended editor**, xEdit's own gesture. On a tab it threw the user out
  of the panel and forced a debounce on every inline string edit.
- **The four-state record order conflict model.** Cannot drive per-cell colour.
- **Record order conflict state in SQL.** Cannot produce ConflictThis or tell wins from loses; classification
  runs in C# on documents.
