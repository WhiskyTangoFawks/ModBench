# xEdit is the reference for record editing

xEdit has 25 years of refinement against this exact problem domain, and essentially every mEdit user arrives fluent in it. So where xEdit has an answer to what the user sees and does with a record, record editing adopts it, and every divergence and omission is recorded in [xedit.md](../out-of-scope/xedit.md). [The xEdit UX audit](../research/xedit-ux-audit.md) and [the conflict-model notes](../research/xedit-conflict-model.md) record what xEdit does.

## Consequences

- **xEdit is the baseline, not the ceiling.** An addition xEdit never had is opt-in behind its own affordance. The default stays xEdit's, no xEdit gesture or meaning is redefined to reach it, and where it overlaps xEdit's ground it takes xEdit's word.

## Alternatives rejected

- **Left-click is edit.** It left nothing for selection, so a read-only surface had to exist to select from; drag consumed the mousedown; bounded-list types were copyable only in immutable columns. Every problem was downstream of the anchor, and every one is absent in xEdit.
- **A per-cell array widget per plugin column.** Cross-plugin element comparison was impossible.
- **The four-state record order conflict model.** Cannot drive per-cell colour.
