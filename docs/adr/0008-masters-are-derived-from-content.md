# Masters are derived from content

A recorded divergence from [ADR-0018](0018-xedit-is-the-reference-for-record-editing.md). xEdit
offers Add, Sort and Clean Masters as user actions because it patches stored FormID bytes in
place, so a master list can drift from the references in the file. Mutagen rebuilds a plugin's
master list from its object graph on every write and re-derives every FormID's master index from
it, so there is no drift to manage: sort and clean are what every compile does.

## Strategic invariants

1. **A plugin's masters are wholly derived from its content and never directly editable.**
   Nothing, not a command and not a script, declares a master ahead of the content that requires
   it, and nothing removes, reorders or cleans one directly. A copy or edit that references
   another plugin's record makes that plugin a master at the next compile.
2. **`masters` is read-only on the header record and shows the Effective masters**
   ([CONTEXT.md](../../CONTEXT.md)). Save & Compile writes exactly that set; deriving it is one
   of the two things the format forces compile to derive
   ([ADR-0007](0007-plugin-edits-are-git-working-tree-changes.md)).
3. **A master naming no loaded plugin is flagged, never deactivated**
   ([ADR-0012](0012-every-plugin-copy-is-indexed.md)).

## Alternatives rejected

- **Add Masters as a user action**, for the real pattern of declaring an otherwise-unused plugin
  as a master purely to pin load order. That is a load-order concern, Mod Management's job,
  expressed invisibly inside an Editing object, per plugin, unauditable from `plugins.txt`, and
  it silently breaks when the referenced plugin updates. The supported way is Mod Management's
  own load-order surface.
