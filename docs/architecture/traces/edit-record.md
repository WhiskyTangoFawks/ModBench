# edit-record: contract

Diagram: [edit-record.d2](edit-record.d2). Catalog rows under Record: `edit field`, `add element`,
`remove element`, `move element`, `create`, `delete`, `copy` and `renumber`, in
[commands.md](../commands.md). What the user picks, types and confirms is in
[plugins.md](../surfaces/plugins.md), [editor.md](../surfaces/editor.md) and
[editor-fields.md](../surfaces/editor-fields.md). Governed by
[ADR-0003](../../adr/0003-modbench-never-assumes-exclusive-ownership-of-a-file.md),
[ADR-0005](../../adr/0005-the-document-is-the-record-model.md),
[ADR-0006](../../adr/0006-decompilation-is-provably-faithful.md),
[ADR-0007](../../adr/0007-plugin-edits-are-git-working-tree-changes.md),
[ADR-0008](../../adr/0008-masters-are-derived-from-content.md),
[ADR-0012](../../adr/0012-every-plugin-copy-is-indexed.md) and
[ADR-0015](../../adr/0015-edits-reach-the-read-model-through-the-watcher.md).

Every gesture here changes a tracked plugin's source in the working tree, and nothing else: no
binary, no commit and no index (ADR-0007, invariant 4). Review and commit are git's.

## The flow

1. Plugins or the Editor sends the gesture to Commands, through the mEdit client and the HTTP
   endpoints: the records, each as its FormKey and its plugin's origin and file name, and the
   gesture's Options. Each record lands or is refused on its own. A cause that no record can
   escape refuses the whole selection once.
2. Commands refuses a record whose plugin cannot take the write: see Refusals.
3. The Source adapter reads the document that holds the record: its own, or its container's for a
   child record (ADR-0006, invariant 4).
4. Commands applies the gesture to the document, as the table below says. The schema decides what
   a field may hold, and Commands adds no rule of its own (ADR-0005).
5. The Source adapter puts each changed document whole, then forgets it. An EditorID change
   renames the record's file first.
6. Commands answers per record: applied, with the new FormKey where there is one, or the refusal.

| Gesture | What changes in the source |
|---|---|
| `edit field` | A field's value is set, or cleared to its default. A new function or Run On empties the condition parameters it leaves unused (ADR-0005, invariant 7). |
| `add element` | An element is appended to an array: the value a drop supplies, or an element empty but for its kind. |
| `remove element` | An element leaves its array. |
| `move element` | An element moves one step in an unsorted array. |
| `create` | A new record of the chosen type, as a new file. Its FormID is the next free one that neither the working tree nor `HEAD` uses, and its EditorID is fresh and unique in the plugin. |
| `delete` | The record's file is removed, or a child record leaves its container's document. The records that reference it are left as they are: compile reports them. |
| `copy`, as override | The record's document lands in the destination plugin's source, under the same FormKey. A destination that already holds the record takes it only with the replace Option, as xEdit's copy as override with overwriting does. |
| `copy`, as new | A duplicate lands in the destination under its next free FormID, with an EditorID derived from the source's and unique in the destination (#867). Its child records get fresh FormKeys, and a reference to itself follows it. A container the destination lacks is created bare, as a Partial Form. |
| `renumber` | The record's FormKey changes, and nothing else. The records that reference it are left as they are: updating them is a script. |

## Hand-off

This flow waits for no hand-off. The Mod watcher sees the source change, the Indexer refreshes
the keys, and the Store publishes the rows that changed. Every view reads again then, and not
before (ADR-0015, invariant 3). A plugin's masters change at its next compile (ADR-0008).

## Refusals

Commands refuses before it writes the record, and names the cause.

| Refusal | Where | Why |
|---|---|---|
| The plugin is not tracked, naming Track | every gesture | An untracked plugin is read-only (ADR-0007, invariant 1). |
| The plugin is in no mod, pointing at a patch plugin | every gesture | The game's plugins are not edited. |
| The record is a losing copy | every gesture | A copy the game does not load is read-only (ADR-0012, invariant 5). |
| A question is open on the mod | every gesture | ADR-0003, invariant 3. |
| The record has gone, naming it | every gesture | A gone object is refused. |
| A field or element that is not there, or a move off either end, naming the path | the element and field gestures | |
| A value the codec rejects, naming the field | `edit field`, `add element` | Refuse, do not repair. |
| Two elements with one key in a keyed array, naming the key | `edit field`, `add element` | The key is the element's identity. |
| A read-only field, with the reason: the schema's, a Partial Form's own field, a container's child slots, or the header's masters | the element and field gestures | ADR-0005, invariant 6; ADR-0008. |
| A record type that cannot be created, or a container record | `create` | Choosing a container's containment is planned (#462). |
| No free FormID is left, naming the remedies: clear the light flag in the header, or renumber | `create`, `copy` as new, `renumber` | |
| The FormKey asked for is taken | `create`, `renumber` | |
| The destination loads before the source | `copy` as override | That is an underride, which is planned. |
| The destination already holds the record, and the replace Option is not given, naming the destination | `copy` as override | Confirm what destroys: the surface asks, then supplies the Option. |
| A cell or a worldspace | `copy` as new | |
| The record is an override, naming its master | `renumber` | Renumber it where it is native. |

## Failure

Each document is written whole. Over a selection, the records that landed stand. No principle has
an exception.

## Test seam

- **Commands:** given the records, the gesture, its Options and the source documents, the documents
  written, renamed and removed, or the refusal and nothing written for that record.
- The views reading again is tested in [index-load-order](index-load-order.d2).
