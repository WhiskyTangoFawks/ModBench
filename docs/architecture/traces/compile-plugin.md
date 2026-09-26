# compile-plugin: contract

Diagram: [compile-plugin.d2](compile-plugin.d2). Catalog row: `compile` under Plugin in
[commands.md](../commands.md). What the user picks and confirms is in
[plugins.md](../surfaces/plugins.md), Compile. Governed by
[ADR-0003](../../adr/0003-modbench-never-assumes-exclusive-ownership-of-a-file.md),
[ADR-0006](../../adr/0006-decompilation-is-provably-faithful.md),
[ADR-0007](../../adr/0007-plugin-edits-are-git-working-tree-changes.md),
[ADR-0008](../../adr/0008-masters-are-derived-from-content.md) and
[ADR-0015](../../adr/0015-edits-reach-the-read-model-through-the-watcher.md).

`compile` writes a tracked plugin's binary from its plugin source. It is the inverse of
[decompile plugin](decompile-plugin.md). It builds from the working tree.

For a tracked plugin, the source is the truth and the binary is its build (ADR-0006; ADR-0007).
Git keeps every state of the source, so compile keeps no copy of the binary. A failed build means a
bad binary, and compiling again rebuilds it.

## The flow

1. Plugins or the Editor sends `compile` to Commands, through the mEdit client and the HTTP
   endpoints: the plugins, each as origin and file name. Each plugin compiles on
   its own.
2. The Source adapter reads the plugin's documents from the working tree. Compile never commits, and never changes a branch or the working tree (ADR-0007,
   invariant 4).
3. Commands checks the documents before it writes anything. The codec reproduces every document
   exactly (ADR-0006, invariant 6), and no two documents claim one FormKey.
4. Commands derives what the format forces: the masters from the content, in load order
   (ADR-0008), and the header's counters (ADR-0007, invariant 4). A light plugin's records must
   fit the light range.
5. Commands records the compiled tree and the new binary's hash as what Modbench last wrote
   (ADR-0003, invariant 1).
6. The Plugin adapter writes the binary, whole or not at all, and a localized plugin's strings
   beside it.
7. Until the next compile, the record before this one also counts as what Modbench last wrote, so
   either binary an interrupted compile leaves is Modbench's own.
8. Commands checks the references. A reference it cannot resolve is a diagnostic, never a refusal
   (ADR-0007, invariant 4).
9. Commands answers per plugin: applied, with the masters and the diagnostics, or the refusal.

## Hand-off

This flow waits for no hand-off.

- The Mod watcher sees the new bytes. They match what Modbench last wrote, so no question opens.
  The Indexer validates the plugin by its hash ([index-load-order](index-load-order.d2)).
- Plugins puts the diagnostics in the Problems panel, on the source files.

## Refusals

Commands refuses before any write, and names the cause.

| Refusal | Why |
|---|---|
| A question is open on the mod | A compile would overwrite the evidence (ADR-0003, invariant 3). |
| The plugin is not tracked | There is no source to compile. |
| The source holds no tree for the plugin | There is nothing to compile. |
| A source file cannot be opened, naming it | Another program may hold it. |
| A document the codec cannot reproduce, naming the path | Re-Track is the remedy (ADR-0006, invariants 5 and 6). |
| Two documents claim one FormKey, naming them | The format holds one record per FormKey. |
| A light plugin holds records outside the light range, naming them | The refusal names the remedies: clear the light flag in the header, rename the plugin off `.esl`, or change the records' FormIDs. |
| A record the format cannot write, naming it | Compile refuses only what it cannot emit (ADR-0007, invariant 4). |

## Failure

- **A failed write** says so, and names the plugin. The source is untouched, so compiling again
  rebuilds the binary.
- **An interrupted compile** leaves the old binary or the new one, and each is what Modbench last
  wrote (step 7), so no question opens. Compiling again builds the binary.

Exceptions to the principles:

- **A failed gesture writes nothing.** An interrupted compile can leave a localized plugin's strings
  written without its binary. The source, which is the truth, is untouched.

## Test seam

- **Commands:** given the plugin, the source and the repository, the binary's records, header,
  masters and strings, what Modbench last wrote, and the diagnostics; or the refusal and nothing
  written.
- **Commands, at a settle:** given the bytes a compile wrote, or the binary before them, no
  question.
