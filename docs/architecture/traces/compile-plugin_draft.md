# compile-plugin: contract (draft)

Diagram: [compile-plugin.d2](compile-plugin.d2). Catalog row: `compile` under Plugin in
[commands.md](../commands.md). It is the inverse of `decompile plugin`. Governed by
[ADR-0003](../../adr/0003-modbench-never-assumes-exclusive-ownership-of-a-file.md),
[ADR-0006](../../adr/0006-the-plugin-is-the-source-of-truth.md),
[ADR-0007](../../adr/0007-plugin-edits-are-git-working-tree-changes.md) and
[ADR-0008](../../adr/0008-masters-are-derived-from-content.md).

Each story cites its source.

## compile

As a user, I want:

1. Compile offered only for a plugin that is tracked and editable. *catalog Where; No dead entries*
2. To choose the source: the working tree, or `main`. *catalog Options*
3. The plugin's binary written from its plugin source. *catalog Meaning*
4. The masters list, the header counters and the FormIDs the format forces derived for me. *ADR-0007,
   invariant 4; ADR-0008*
5. Compile to refuse only what it cannot write, and to say why. Every other problem shows as a
   diagnostic in the Problems panel. *ADR-0007, invariant 4; ADR-0019*
6. A source document that the codec cannot reproduce refused, naming the path. The remedy is to Track
   again. *ADR-0006, invariants 5 and 6*
7. Compile refused while an external change to the mod is unanswered. *ADR-0003, invariant 3*
8. The previous binary kept while compiling, and put back if the compile fails. *catalog Meaning*
9. A failed compile to say why. *A failed gesture writes nothing; ADR-0019*
10. Compile never to commit and never to change my branch. *ADR-0007, invariant 4*
11. Each compile, from any source, to record what was compiled. *ADR-0003, the parked ref*
12. The change to reach the views when the watch reads the new bytes. *ADR-0015; diagram*
13. Compile at `main` to leave my edit branch and my working tree untouched. *catalog Options*

## Test seam

- **The driving box:** what is offered, the pickers, the prompts, the confirmations, and Esc.
- **The Core box:** given its Argument and Options, what it writes, or the refusal.

## Open Questions

1. **Confirm what destroys.** Answered: compile does not ask. A tracked plugin's source is the truth
   and the plugin a projection of it, so compile destroys nothing (plugins.md, Compile story 1).
2. **No target.** The old spec opens a list of every loaded plugin when the palette gives no target.
   Should it list only tracked and editable plugins?
3. **Strings.** A localized plugin with a missing strings file is refused, naming the file. The old spec
   also writes strings beside the plugin. Accept?
4. **A crash between two writes.** The principle holds, so a plugin and its strings must not disagree
   after a crash. How compile achieves it needs design in the same ticket.
5. **A `.bak` file.** Story 8 follows the catalog. The old spec keeps five and prunes. Is the count
   a rule?
6. **Crash recovery is cut.** The old spec describes a recovery offer after an interrupted compile, or
   when a tracked binary cannot be read. It has no catalog row, and ADR-0007 names the round-trip gate
   and tracking again as the recovery. Any code for it is code to cut.
