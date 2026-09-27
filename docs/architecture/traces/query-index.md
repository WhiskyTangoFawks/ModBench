# query-index: contract

Diagram: [query-index.d2](query-index.d2). Catalog rows under Record: `open` and `filter`, in
[commands.md](../commands.md). What the views show is in [plugins.md](../surfaces/plugins.md),
[editor.md](../surfaces/editor.md) and [editor-referenced-by.md](../surfaces/editor-referenced-by.md).
Governed by
[ADR-0005](../../adr/0005-the-document-is-the-record-model.md),
[ADR-0009](../../adr/0009-the-record-index-mirrors-the-files-on-disk.md),
[ADR-0012](../../adr/0012-every-plugin-in-the-instance-is-indexed.md),
[ADR-0013](../../adr/0013-mod-management-hands-editing-the-load-order.md),
[ADR-0015](../../adr/0015-edits-reach-the-read-model-through-the-watcher.md) and
[ADR-0019](../../adr/0019-failures-are-data-the-front-end-decides-how-to-surface-them.md).

A query reads the Store, and never a file, git or a plugin's bytes. It answers from the last
projection, which [index-load-order](index-load-order.md) and the Mod watcher write, and it writes
nothing. The record types a game can create are the schema's answer, not the Store's.

## The flow

1. A view asks the mEdit client a question. The client sends it to Queries, through the HTTP
   endpoints. A record is named by its FormKey, and a plugin by its origin and file name
   (ADR-0012, invariant 1).
2. Queries reads the Store's rows of the active plugins, joined at read (ADR-0009, invariants 1
   and 2), and answers. A FormKey resolves only to a record an active plugin holds. A plugin's own
   statuses answer for every plugin in the index.
3. The mEdit client hands the answer to the view.

| Question | Asked by | Answer |
|---|---|---|
| A plugin's record types and counts, a group's records, a container's children | Plugins | An active plugin's rows, narrowed by the record filter. |
| The plugin list | Plugins | Each plugin in the index, with its statuses: parse failures and tracked or not; and, for an active plugin, master issues and whether the record filter leaves it a record. |
| A record's comparison | the Editor | One column for each active plugin that holds the record (ADR-0012, invariant 5), with each field's value and its conflict states ([editor-conflicts.md](../surfaces/editor-conflicts.md)). |
| The references to a record | Referenced By | Each referrer, and the active plugins that hold the reference, with the fields that hold it. A condition parameter its function does not use holds no reference (ADR-0005, invariant 7). |
| A search by EditorID, FormID or FormKey | the record picker | The matching records of the active plugins. |
| The record types a plugin's game can create | Plugins, create record's type pick | Each record type the game's schema can create, named as xEdit names it. |
| A malformed plugin's diagnosis | Plugins | The reasons the Indexer recorded. |

## The record filter

- **Set.** The Index runs the filter's SQL once against the active plugins' rows, and keeps the FormKeys it
  returns, the SQL and its source. The filter narrows every listing: the records, the type counts and which
  plugins keep a record. It never narrows a read of one record, or its references.
- **After each reconcile,** the Index runs the SQL again.
- **Clear** drops it.

## While the index is not ready

| Index status | What a query answers |
|---|---|
| reconciling | The plugins indexed so far. The status says the conflicts are not final ([editor.md](../surfaces/editor.md), States, story 3). |
| none, held elsewhere, or failed | No answer. The view shows its error row, with the status's reason. |
| ready, and no plugin holds the record | Not found ([editor.md](../surfaces/editor.md), States, story 4). |
| ready, and only plugins that are not active hold the record | No column ([editor.md](../surfaces/editor.md), States, story 5). |

## Hand-off

This flow waits for no hand-off. A view reads again on the rows that changed. The Store publishes
them with a sequence, and a view that must read at or after it waits for the index to reach it
(ADR-0015, invariant 3).

## Refusals

| Refusal | Where |
|---|---|
| The SQL returns no FormKey column | `filter` |
| The SQL cannot run, with the database's reason | `filter` |

## Test seam

- **Queries:** given the Store's rows and the load order, the answer. Given a filter's SQL, the
  FormKeys it keeps and the listings it narrows, or the refusal.
