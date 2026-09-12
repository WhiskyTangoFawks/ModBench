# Target architecture: how to read the diagrams

mEdit is the C# service in `MEditService/`; Modbench is the VS Code extension in `modbench/`.
The decisions the pictures draw are
[ADR-0014](../adr/0014-modules-are-layered-and-call-adjacent-layers-through-ports.md) (the
layers and their ports), [ADR-0015](../adr/0015-edits-reach-the-read-model-through-the-watcher.md)
(how a change flows) and [ADR-0013](../adr/0013-mod-management-hands-editing-the-load-order.md)
(what crosses between the two processes); this file says how to read the pictures.

## The set

- [target-architecture.d2](target-architecture.d2) is the zoom-out and the one place a box is
  defined. One grid, six rows for the layers, two columns for the processes, so each mEdit layer
  sits beside its Modbench twin and means the same thing. A module box carries three lines: its
  name, `interface:` what other boxes may call, `hides:` what they may not. A cylinder is a store
  and carries what it holds; purple is a system of record, green is derived from what sits beside
  it and can be rebuilt. It has no arrows.
- [target-architecture-references.d2](target-architecture-references.d2) is the reference view:
  the zoom-out's boxes with one arrow per reference, from the box that references to the box it
  references. This picture is each project's reference list. A thin purple arrow is a read or
  write of a system of record. A grey arrow is the user, another tool, or the wire between the
  two processes.
- [traces/](traces/) holds one sequence diagram per gesture family, and two that cross families
  end to end, a tracked mod changing on disk and upgrading a mod. Actors are the zoom-out's
  boxes, imported by name; time runs down; a message is labelled with what moves, never with the
  call, so a request and its reply are two messages. A note on an actor is what it does between
  messages.
- [styles.d2](styles.d2) is the shared vocabulary. A box class is its layer: driving, core,
  kernel, driven, a system of record, derived; in a trace the actor's colour is the only layer
  mark. A message class says which gesture family the payload belongs to, and a reply takes its
  request's class. A signal is dashed grey and carries no payload, a watch event or a bare
  request; a push is dashed purple and names what changed, and the receiver re-reads.

## The layers

Both columns use the same six names. Drivers: who drives the process. Driving adapters: what
turns a driver's gesture or a file's change into a call. Core: the rules, one command per
gesture. Kernel: pure, read by every box above it. Driven adapters: what the core calls to reach
a system of record. Systems of record: the files that are the truth.

## The pictures are the reference lists

A box is a project. Its reference list is the arrows that leave it in the reference view, plus its
column's kernel by the band's rule: a kernel box references only Vocabulary on mEdit and nothing on
Modbench. A composition root, the HTTP endpoints on mEdit, the activation file and Toolbox on
Modbench, references every box below it by definition. A reference the reference view does not
draw is a compile error and a question for the maintainer, never a line an agent adds.

## Why the two columns match

Each process has its own systems of record and one read model over them, built only by
watching: the record index over the plugin files and the source tree, the Instance over MO2's
files. A command writes a file and forgets, so a change from another tool and a change from
Modbench are the same signal in both, which is what
[a-change-from-another-tool](traces/a-change-from-another-tool.d2) draws. The two meet at one
value, the load order snapshot, and one stream. mEdit is always running, so no view has a mode
for its absence; a disconnect is an error the views surface.

## Rules the Modbench column draws

Change flows up only through watchers and the notification port. mEdit watches one folder per
mod, and the Source repository names the paths inside it, so layout has one owner. No command
reads the Instance; a value a command needs, the folders to adopt or the plugins to reconcile,
arrives as an argument. Deploy is a module inside Toolbox and reads one value with its sequence.
The Instance is derived from disk and nothing else; it recomputes whole, keeps its last value on
a parse failure, and validates on activation and Refresh through the same path
([the-instance-recomputes](traces/the-instance-recomputes.d2)). Outside two per-release tables,
game paths and the load-order file destination, no Modbench file names a game; a source scan
holds it. Mods, Downloads and Toolbox never see a record.

## What is left out

Deliberately absent, so that every arrow drawn stays legible: the repair engine
([medit-repair.md](../specs/medit-repair.md)), and MO2's own UI beyond the trees Modbench renders.

## Rendering

```bash
# from docs/architecture/, with d2 on PATH (https://d2lang.com/tour/install)
d2 target-architecture.d2 target-architecture.svg
d2 target-architecture-references.d2 target-architecture-references.svg
for f in traces/*.d2; do d2 "$f" "${f%.d2}.svg"; done
```

The `terrastruct.d2` VS Code extension previews a file live while it is edited.

## Maintaining

- A box is defined once, in the zoom-out. Its id is the project's name; its band is its layer and
  its process. A trace imports an actor from the zoom-out (`commands: @../target-architecture.medit_core.commands`)
  and overrides the label to the name alone, so a box renamed or removed in the zoom-out breaks
  every trace that draws it until the trace follows.
- A module box's caption is three lines, name, `interface:`, `hides:`, each a noun list. A caption
  line wraps at about 64 characters, because a box is as wide as its longest line. Nothing with
  an arrow in it belongs in a caption; a flow is a trace.
- Order is declaration order. In the zoom-out a box's row is its layer and its position in the
  row is where it is written. Both counts are declared, `grid-rows` and `grid-columns: 2`, because
  a row count alone lets the layout pack cells by width and break the columns; the reference view
  has one more row for its legend.
- Arrows inside a grid are straight lines and their labels collide, so the zoom-out carries none
  and the reference view carries them unlabelled. Every payload lives in a trace.
- A trace declares its actors in the order they first appear in the story and its messages in
  story order. An actor that is a set of boxes, `every view`, is declared in the trace with the
  set as its label. A branch, a dialog or a pick is a note on the actor that holds it, not an
  actor.
- A trace message runs between two boxes the reference view joins, or across the wire, or inside
  one box. A message between boxes the reference view does not join is a reference the maintainer
  has not drawn. The one exception is an end-to-end trace that abbreviates another trace as one
  message named after it, as upgrade-a-mod does with a-tracked-mod-changes-on-disk.
- A new module is a box in the zoom-out with its three lines. A new reference is an arrow in the
  reference view. A new payload is a message in the trace of its gesture, in that gesture's class.
  A new gesture family is a new trace and a new class in the styles file.
- Render before committing and look at the picture. A change that makes a diagram false changes
  the diagram in the same change, and the ADR it cites with it.
