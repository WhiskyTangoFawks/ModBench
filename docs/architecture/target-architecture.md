# Target architecture: how to read the diagrams

mEdit is the C# service in `MEditService/`; Modbench is the VS Code extension in `modbench/`.
The decisions the pictures draw are
[ADR-0014](../adr/0014-modules-are-layered-and-call-adjacent-layers-through-ports.md) (the
layers and their ports), [ADR-0015](../adr/0015-edits-reach-the-read-model-through-the-watcher.md)
(how a change flows) and [ADR-0013](../adr/0013-mod-management-hands-editing-the-load-order.md)
(what crosses between the two processes); this file says how to read the pictures.

## The set

- [target-architecture.d2](target-architecture.d2) is the zoom-out: one grid, six rows for the
  layers, two columns for the processes, so each mEdit layer sits beside its Modbench twin and
  means the same thing: who drives it, the driving adapters, the core with its write and read
  sides, the kernel both sides read, the driven adapters, the systems of record. The Instance is
  Modbench's record index and the mEdit client is Modbench's write side for editing. A box is a module
  and carries its interface and what it hides. A cylinder is a store; purple is
  a system of record, green is derived from what sits beside it and can be rebuilt. It has no
  arrows.
- [target-architecture-data-flow.d2](target-architecture-data-flow.d2) is the master data-flow
  view: the same boxes, imported from the zoom-out, with every arrow drawn, coloured by gesture
  family and unlabelled. It shows the topology; the trace of the same colour carries the labels.
- [traces/](traces/) holds one diagram per gesture family, and two that cross families end to end,
  a tracked mod changing on disk and upgrading a mod, each of which is one story: the path one
  gesture takes end to end, in its colour, with the watch that closes the loop. An arrow points the way data moves and is
  labelled with what moves, never with the call, so a request and its reply are two arrows.
- [styles.d2](styles.d2) is the shared vocabulary. A box class says what a module is: driving,
  core, driven, a system of record, derived. An arrow class says which gesture family the payload
  belongs to. A signal is dashed grey and carries no payload; a push is dashed purple and names
  what changed, and the receiver re-reads.

## The pictures are the reference lists

A box is a project. Its reference list is the arrows drawn into the boxes beneath it, plus the
kernel by the band's rule: the shared kernel is read by every box above it, and a kernel box
references only Vocabulary on mEdit and nothing on Modbench. A composition root, the HTTP endpoints
on mEdit, the activation file and Toolbox on Modbench, references every box below it by
definition, and that is not an arrow. A reference the pictures do not draw is a compile error and a
question for the maintainer, never a line an agent adds.

## Why the two columns match

Each process has its own systems of record and one read model over them, built only by
watching: the record index over the plugin files and the source tree, the Instance over MO2's files. A
command writes a file and forgets, so a change from another tool and a change from Modbench are
the same signal in both, which is what [a-change-from-another-tool](traces/a-change-from-another-tool.d2)
draws. The two meet at one value, the load order snapshot, and one stream. mEdit is always
running, so no view has a mode for its absence; a disconnect is an error the views surface.

## Rules the Modbench column draws

Change flows up only through watchers and the notification port. mEdit watches one folder per
mod, and the Source repository names the paths inside it, so layout has one owner. No command reads the Instance;
a value a command needs, the folders to adopt or the plugins to reconcile, arrives as an
argument. Deploy is a module inside Toolbox and reads one value with its sequence. The Instance is derived from disk and nothing else; it
recomputes whole, keeps its last value on a parse failure, and validates on activation and
Refresh through the same path ([the-instance-recomputes](traces/the-instance-recomputes.d2)).
Outside two per-release tables, game paths and the load-order file destination, no Modbench file
names a game; a source scan holds it. Mods, Downloads and Toolbox never see a record.

## What is left out

Deliberately absent, so that every arrow drawn stays legible: the repair engine ([medit-repair.md](../specs/medit-repair.md)), and
MO2's own UI beyond the trees Modbench renders.

## Rendering

```bash
# from docs/architecture/, with d2 on PATH (https://d2lang.com/tour/install)
d2 target-architecture.d2 target-architecture.svg
d2 target-architecture-data-flow.d2 target-architecture-data-flow.svg
for f in traces/*.d2; do d2 "$f" "${f%.d2}.svg"; done
```

The `terrastruct.d2` VS Code extension previews a file live while it is edited.

## Maintaining

- Order is declaration order. In the zoom-out a box's row is its layer and its position in the
  row is where it is written. Both counts are declared, `grid-rows` and `grid-columns: 2`, because
  a row count alone lets the layout pack cells by width and break the columns; the data-flow view
  has one more row for its legend.
- Arrows inside a grid are straight lines and their labels collide, so the zoom-out carries none,
  the data-flow view carries them unlabelled, and every label lives in a trace. An arrow added to
  a trace is added to the data-flow view in the same change, and the reverse.
- A trace reads from the gesture's first box down. The layout engine puts a box with no inbound
  arrow first, so a trace whose gesture starts elsewhere says `direction: up`, as query does,
  and arrows are declared in story order.
- A new module is a box in the zoom-out with its interface and what it hides. A new payload is
  an arrow in the trace of its gesture, in that gesture's class. A new gesture family is a new
  trace and a new class in the styles file.
- Render before committing and look at the picture. A change that makes a diagram false changes
  the diagram in the same change, and the ADR it cites with it.
