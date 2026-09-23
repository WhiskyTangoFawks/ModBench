# query-index: contract (draft)

Diagram: [query-index.d2](query-index.d2). Catalog rows under Record: `open`, `filter` and `show referenced by`, in
[commands.md](../commands.md). Governed by
[ADR-0009](../../adr/0009-the-record-index-mirrors-the-files-on-disk.md),
[ADR-0015](../../adr/0015-edits-reach-the-read-model-through-the-watcher.md),
[ADR-0018](../../adr/0018-xedit-is-the-reference-for-record-editing.md) and
[ADR-0019](../../adr/0019-failures-are-data-the-front-end-decides-how-to-surface-them.md).

Each story cites its source. A query reads the Store only. It never reads a file.

## Shared

As a user, I want:

1. An answer that reflects the last projection, and to see a change only after the projection lands.
   *diagram header; ADR-0015, invariant 3*
2. A failed fetch shown inline and in the Output, never as a pop-up. *ADR-0019, the background tier*
3. A query to write nothing. *catalog Effect: reads*

## show referenced by

As a user, I want:

1. The Referenced By list to follow the active record, with no menu entry. *catalog Where and Meaning*
2. It to list the records that reference the active record. *catalog Meaning*
3. The list to be there when it has nothing to show. *Where surfaces live: every view is always present*

## filter

As a user, I want:

1. The record tree narrowed to the FormKeys a SQL query returns. *catalog Meaning*
2. A query from an input box, or from a document. *catalog Options*
3. The filter to stay until I clear it, with its source in the view description. mEdit keeps the
   source with the filter. *One filter; [plugins.md](../surfaces/plugins.md), The view*
4. A plugin with no record left under the filter hidden while it is active. The record filter is its
   own filter, beside the name filter. *ruling; [plugins.md](../surfaces/plugins.md)*

## open

As a user, I want:

1. A record opened in an editor tab. *catalog Meaning*
2. Several records to open as a comparison. *catalog Meaning*
3. A picker that finds a record by FormID or EditorID when I give none. *catalog Meaning*
4. The record to open beside the current one, if I ask. *catalog Options*

## Test seam

- **The driving box:** what each surface asks for, and what it draws from the answer.
- **The queries box:** given a question and the Store's rows, the answer, or the failure.
