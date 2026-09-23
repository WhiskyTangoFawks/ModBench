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
- [traces/](traces/) holds one sequence diagram per flow. Gestures whose arrows are the same share
  one, and the diagram names each one's command and the box it calls. Beside each diagram a `.md`
  file of the same name holds its contract. Actors are the zoom-out's
  boxes, imported by name; time runs down; a message is labelled with what moves, never with the
  call, so a request and its reply are two messages. A note on an actor is what it does between
  messages.
- [styles.d2](styles.d2) is the shared vocabulary. A box class is its layer: driving, core,
  kernel, driven, a system of record, derived; in a trace the actor's colour is the only layer
  mark. A message class says which kind of payload it is, and a reply takes its
  request's class. A signal is dashed grey and carries no payload, a watch event or a bare
  request; a push is dashed purple and names what changed, and the receiver re-reads.

## The layers

Both columns use the same six names. Drivers: who drives the process. Driving adapters: what
turns a driver's gesture or a file's change into a call. Core: the rules, one command per
gesture. Kernel: pure, read by every Core box and driven adapter; a port lives here only where
the box that implements it sits above the boxes that call it, so both reference the kernel and
nothing references up or across.
Driven adapters: what the core calls to reach a system of record, and the only boxes that read
or write one. Systems of record: the files that are the truth.

## The pictures are the reference lists

A box is a project. Its reference list is the arrows that leave it in the reference view, plus, for
a Core box or a driven adapter, every box of its column's kernel by the band's rule; a driving
adapter's kernel reads are drawn. A kernel box references nothing above it: on mEdit, Ports reads
Load order state and the other two read nothing; on Modbench a kernel box references nothing.
Every arrow points down or into the kernel, with five same-band references the captions name: the
record index reads the two adapters beside it, Ports reads Load order state, the Instance loader reads the Instance
adapter, plugins commands ask the mEdit client which plugins load implicitly, and instance commands
hand the mEdit client the load order and ask it to rebuild. A composition root, the HTTP endpoints
on mEdit and the activation file on Modbench, references every box below it by definition.
A reference the reference view does not draw is a compile error and a question for the
maintainer, never a line an agent adds.

## Why the two columns match

Each process has its own systems of record and one read model over them, built only by
watching: the record index over the plugin files and the source tree, the instance value over MO2's
files. A command writes a file and forgets, so a change from another tool and a change from
Modbench are the same signal in both
([ADR-0015](../adr/0015-edits-reach-the-read-model-through-the-watcher.md), invariant 2). No trace
draws that signal on its own, because there is no separate path: it is the watch that opens
[load-instance](traces/load-instance.d2) and [index-load-order](traces/index-load-order.d2), and the
settle that opens decompile-plugin's trigger. The two meet at one
value, the load order snapshot, and one stream. mEdit is always running, so no view has a mode
for its absence; a disconnect is an error the views surface.

## Rules the Modbench column draws

Change flows up only through watchers and the notification port. mEdit watches one folder per
mod, and the Source adapter names the paths inside it, so layout has one owner; on the
Modbench side the Instance adapter is that owner, the one box that reads or writes the instance: the mod
manager's configuration, the load order, and which game it is for. Game Data/ is not a system of record but
a projection, and deploy alone writes it. A command splices through the pure codec and puts through the Instance adapter. No command reads the
Instance loader; a value a command needs, the folders to import and the mod lines to prune, the plugin lines to add and drop, or the winners
to deploy, arrives as an argument. Deploy and purge are commands; Toolbox offers the gesture and
keeps the first-deploy consent.
The Instance loader builds its value from disk and nothing else. It rebuilds the whole value. It
keeps the last value on a parse failure. It validates on activation and on refresh, through the
same path ([load-instance](traces/load-instance.d2)). Outside two per-release tables,
game paths and the load-order file destination, no Modbench file names a game; a source scan
holds it. Modbench does not depend on one mod manager. The game owns the format of `plugins.txt`.
The mod manager owns every other file in the instance. The Instance adapter is a repository. MO2
is one implementation of it. Only that implementation names MO2. A source scan holds this rule,
as it holds game names. Mods, Downloads and Toolbox never see a record.

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
- A trace message runs between two boxes the reference view joins, or through a port, where one
  end implements it and the other references Ports, or across the wire, or inside one box, or
  between two boxes a composition root wires, as the HTTP endpoints hand a request to a Commands
  handler. Any other message is a reference the maintainer has not drawn. The one exception is a trace
  that abbreviates another trace as one message named after it.
- A new module is a box in the zoom-out with its three lines. A new reference is an arrow in the
  reference view. A new payload is a message in the trace of its gesture, in that gesture's class.
  A new flow is a new trace and, if its payload is a new kind, a new class in the styles file.
- A box's `CLAUDE.md` opens with its purpose in plain words, consistent with its caption. A new box
  gets one, and a caption edit rereads it.
- Render before committing and look at the picture. A change that makes a diagram false changes
  the diagram in the same change, and the ADR it cites with it.
