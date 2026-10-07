# A child record lives in its container's document

The game uses the order of some child records: the engine reads a dialog topic's responses in order, and some plugins hold that order only in each response's position. Mutagen's serialization keeps a list's order only inside the container's document or in numbered file names, and a numbered name changes when an earlier sibling is inserted or deleted. So a child record lives inside its container's document, in Mutagen's list order. A worldspace's grid cells are the exception: each keeps Mutagen's file of its own, because the grid decides a cell's place, not a list ([principles](../principles.md): Mutagen's data; Existing tools).

## Consequences

- A child record has no file of its own, so to VS Code its file is its container's file (ADR-0001).
- A container's document can be large, because a quest holds its topics and each topic holds its responses.

## Alternatives rejected

Each alternative below was built or proposed at least once. Before this ADR, each rejection was reached again from the start. The tickets hold the evidence.

### Each child in a file of its own, ordered by numbered file names

Mutagen's serialization ships this mode: each file name starts with the child's position, `[N] `. Modbench used it from #459. An insert or a delete renames every later sibling: one deleted quest of 13 in a group showed 25 changes in Source Control. Git cannot pair the renames, because its unstaged status never matches a deleted file with an untracked one. Gaps left by a delete do not help: Mutagen numbers from zero on each decompile, so the next decompile of an unchanged plugin renames every sibling after a gap.

### The same numbered files, with the renames hidden in the IDE

The fallback #566 proposed. Modbench stages the renames, so Source Control pairs them. This treats the symptom: a merge, a reviewer and `git status` outside Modbench still see every rename, and a conflict spreads across the renamed files.

### Each child in a file of its own, ordered by a list Modbench keeps in the container

Built in #566, and deleted three days later by #745. The container's document held the ordered FormKeys of its children, and each child's file had a name from its identity alone. Mutagen's serialization has no hook for such a list, so Modbench wrote the list after each serialization and reordered each collection after each read. Each shape of the tree needed its own rule: a flat group needed a minted group document, a block level held its children in its own folder, and a cell's children stayed embedded. The list had to survive every reserialize and every document edit, and the list and the files could disagree, a failure no plugin has. #745 named it a second structural model that neither the plugin nor the index has.

### The same list as a Mutagen customization

Reviewed in October 2026. Mutagen's serialization could write a list one file per child, with the order as FormKeys in the container's document, in about 150 lines across its runtime and its source generator. Mutagen would then own the list, and a mismatch would be a parse failure. Starfield's topic already holds a list of its responses. Placed references stay in their cell either way: Spriggit, the one shipped consumer of the library, embeds them in every game, and no measurement shows that a file for each placed reference is viable. Dialogue in files and placed references embedded is two layouts, and two layouts cost more than one. The answer changes if a file for each placed reference proves viable.

### Each child in a file of its own, with a position key in its own document

An integer key moves the numbering from the file name into the document: an insert rewrites every later sibling's document. A key between its neighbours, such as a fraction, lets an insert touch one file. But a decompile reads only the plugin and assigns fresh keys, so the decompile of a new upstream version rewrites every key after the first insert.

### Each child in a file of its own, with a pointer to its previous sibling

Skyrim's responses carry this pointer, `PNAM`. Two branches that each append a child claim the same predecessor, and git merges them with no conflict and no single order. Fallout 4's master leaves the field empty in all 78,087 responses, so Modbench would write subrecords into the compiled plugin that the original does not hold. Where a plugin does hold the pointer, it does not always decide the order: in Skyrim's DLC masters, 1.3% of topics with more than one response have no single chain, and 0.9% have a chain that disagrees with the plugin's order (#464).

### Children sorted, so no order is kept

xEdit sorts a changed group by FormID when it saves it, and Spriggit sorts placed references by FormKey. But xEdit documents that the engine reads a topic's responses in order. xEdit builds that order for the older games and leaves it unbuilt for Fallout 4. Fallout 4's master and Skyrim's base master store the order in no other place (#464), so a sort changes which line an NPC speaks.

### Order kept only where the game is known to need it

Responses keep their order and every other list is sorted. No source shows that the game ignores the order of the other lists, so the sort risks a silent change to gameplay. Responses still need their order, so the embedding and its cost stay, and the other lists gain a second rule.
