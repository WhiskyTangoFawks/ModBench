# Direct-to-File Editing (bypassing pending changes)

Modbench does not offer a mode where record edits skip the pending-change buffer and go
straight to the plugin file.

## Why this is out of scope

The request dissolves under the right framing: the pending-change model already *is* the
"text editor buffering until save" model. An edit made in the record editor stages
automatically — there is no accept gesture between editing a cell and the change taking
effect in every read (reads overlay pending via views, ADR-0025). Until save, the plugin is
a dirty buffer; save writes the file. That is the semantics a "direct mode" was reaching
for, and it already exists as the default and only mode.

What a true write-through toggle would actually remove is not friction but three
load-bearing properties:

- **The review surface** (change groups, ADR-0017/0028). This sits at the junction of UX
  and AI change review: agent-proposed edits must be inspectable before they touch a binary
  the user cannot diff. A bypass mode deletes the oversight point.
- **Stage-time validation** (ADR-0020). FormLinks are checked on entering the buffer, not
  discovered broken at write time.
- **The write/backup discipline** (ADR-0008). Every write backs up the target plugin first.
  Write-on-every-edit either rewrites the plugin (plus a timestamped `.bak`) per cell
  commit, or reintroduces a buffer under another name.

xEdit — the UX reference (ADR-0034) — does not write through either: it edits in memory and
saves on demand. There is no parity argument for write-through.

If per-group save ceremony ever feels heavy, the remedy is a lighter save-all gesture over
the same buffer, not a second write model.

## Prior requests

- #350 — "Pending Change Mode needs a toggle"
