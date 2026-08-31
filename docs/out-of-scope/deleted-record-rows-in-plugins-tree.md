# Deleted-record rows in the plugins tree

The plugins tree does not show rows for working-tree-deleted records (no "D badge"
ghost rows). A deleted record's row disappears from the tree; the deletion is
reviewed and reverted in the native Source Control panel, where the record's
source file carries git's own D badge.

## Why this is out of scope

The tree and the SCM panel deliberately render different refs of the same model,
mirroring how VS Code itself splits Explorer from SCM:

- **The plugins tree renders Effective** — the record inventory the source
  currently describes, i.e. what the next compile would produce. Every consumer
  of the tree's two query paths (type counts, record listing) is Effective-rooted,
  and "hidden means absent" is an invariant, not an accident.
- **The SCM panel renders the divergence** (Effective vs Head) — modifications,
  additions, and deletions alike, for free, via the mod folder's own git repo.

VS Code's Explorer is the idiom reference for tracking/compile UX (root CLAUDE.md
carve-out: xEdit has no working-tree model), and Explorer does *not* keep a
deleted file's row visible with a badge — the row disappears and the deletion is
reviewed in SCM. Modbench already matches that exactly.

Building the badge would mean teaching both backend query paths a Head-union view
so the tree could render ghost rows — records present at Head but absent at
Effective. That is backend surgery across two read paths in order to *diverge
from* the native idiom. An ingest-from-source rearchitecture does not change this
question: a deleted record is still "absent from source, visible in SCM" under
any ingest design.

If SCM's file-path presentation (`…/NPC_/0001A2B3.json` rather than a record
display name) ever hurts in practice, the cheaper future answer is enriching SCM
presentation, not ghost rows in the tree.
