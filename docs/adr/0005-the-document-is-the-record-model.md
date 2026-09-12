# The document is the record model

## Strategic invariants

1. **The document is the model, on the wire and on disk.** A record is a JSON document reflected
   from Mutagen's own record types, carrying every member the assembly declares at the record's
   own nesting. The wire carries that document and the source tree stores it
   ([ADR-0006](0006-the-plugin-is-the-source-of-truth.md)). There is no second
   model: no parsed struct for a special concern, no DTO beside the document, no member the codec
   never wrote, no new wire shape for a new concern. A concern that looks special is a field,
   with a field's gestures.
2. **Mutagen owns the typing.** What a member is, its type, nullability, enum domain, link
   targets and concrete leaves, is read off the pinned assembly, never transcribed, and one
   field-metadata tree is the only wire contract. A record is a Mutagen object only while it is
   read from bytes or written to them. The codec is the one shape gate: an edit reaches a live
   object only by deserializing through it. Gates: `BannedApiScopeTests`,
   `HandWrittenApplierScanTests`, `GameNamespaceScanTests`.
3. **xEdit owns the presentation.** What a value reads as, the gesture that edits it, which
   arrays sort and by what, is xEdit's answer
   ([ADR-0018](0018-xedit-is-the-reference-for-record-editing.md)). Presentation changes no edit
   value and no copy value.
4. **Per-game knowledge is annotation data, validated against the assembly, never code.** What
   reflection cannot answer is one validated row per fact, one table per concern per game. A row
   that does not resolve fails schema generation and names itself. A fact the assembly can answer
   is never in a table, because the table would drift from it silently. Adding a game is additive
   in one place.
5. **Nothing is dropped in silence.** A record the codec cannot read is indexed read-only with
   its diagnosis. A shape the type walk cannot place is named and counted. A fact a document does
   not carry, a placed reference's cell or a cell's block, is GRUP structure read into tables
   beside the records at ingest, so placement is read-only. A write that cannot be honored leaves
   the file and the record index exactly as they were.
6. **The webview decides nothing.** It renders a cell from the metadata, names no game, holds no
   default beyond what an omitted member means, and posts what the user asked for. The codec and
   a short closed list of pre-checks that need only the schema refuse on the server; anything not
   on that list is not a check. A value's resolution arrives with it, because a link affordance is
   decided before the hover
   ([ADR-0019](0019-failures-are-data-the-front-end-decides-how-to-surface-them.md)).
7. **A cascade idles by removing.** When a governing member's change puts a sibling out of use,
   the write side removes that member, so it reads as its declared default and never the CLR
   default. The webview never reproduces the cascade.

## Alternatives rejected

- **A hand-written codec for conditions**, or for the next concern that looks as divergent.
  Mutagen's four condition graphs are one union shape, which the reflector models directly: the
  sparse union of every leaf's members plus the discriminator, one shape per leaf where they
  differ. The per-value residue is two annotation rows. No hand-written Mutagen-edge codec exists
  anywhere in the stack.
- **A schema per union leaf.** The discriminator already distinguishes the leaves; a second axis
  describes the same fact twice.
