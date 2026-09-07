# Target architecture: how to read the diagram

[target-architecture.drawio](target-architecture.drawio) has two pages, one per process. The
invariants they draw are stated in words in
[ADR-0046](../adr/0046-ports-and-adapters-with-a-write-side-a-read-side-and-one-way-data-flow.md)
for the backend and in the PRDs that carry the extension's target until their ADR lands; this
file only says how to read the picture.

## One picture, two readings

The diagram is a dependency diagram and a data-flow diagram at once.

- **Boxes are the dependency half.** A box is a module. On the backend page a band is a layer
  and a box may talk only to the band beneath it. On the extension page a box carries its
  interface, everything a caller must know, and what it hides. A cylinder is a store; a purple cylinder is a system of record and a green
  one is derived from what sits beside it and can be rebuilt.
- **Arrows are the data-flow half.** An arrow points the way data moves and is labelled with
  what moves, never with the call. A request and its reply are therefore two arrows. A solid
  arrow carries a payload. A dashed grey arrow is a watch, a signal or a result with no
  payload. A dashed purple arrow is a push.
- **Colour is the use case.** Every solid arrow belongs to one gesture family, named in the
  legend of its page. Following one colour end to end traces that gesture.

Two worked traces:

- *Edit a record*, backend page: blue from the extension to the HTTP endpoints, to Commands, to
  the Source repository, to the source tree; then purple from the source tree through the
  Projector to the Store, and a dashed purple push back up to the extension, which re-reads.
- *Enable a mod*, extension page: teal from the Mods view to the modlist command, to the
  modlist.txt codec, to the instance on disk; the dashed watch from disk into the Instance,
  which recomputes its value; teal from the Instance to every view and to the mEdit client as
  the load order snapshot, and on to the backend, where the backend page picks it up as its own
  "load order snapshot" arrow.

## The pages

**mEdit backend.** Five layers: front end, API, core, access, data. Two systems of record, the
plugin files and the source tree, and one read model, the Index. The extension is one box.

**The extension.** The same shape, drawn for the other process. Five bands: views, commands,
read models, kernel, data. The kernel is one module per MO2 file, parse and byte-faithful
splice. Commands are one function per gesture beside the codec of the file they write; each
writes and forgets. The Instance is the one read model, derived from MO2's files by watching
and nothing else, holding one immutable value with a sequence. The mEdit client is the other
read model's door: the extension's side of the backend seam, a port with an HTTP adapter and
an in-memory one, lifecycle inside. The views read the Instance and the client and fire
commands. Deploy lives inside Toolbox and reads the Instance; the backend sync is one function
that sends the load order snapshot on change and on connect.

**Why the two pages match.** Each process has its own systems of record and one read model
over them, built only by watching, so a change from another tool and a change from Modbench
are the same signal in both. They meet at one value, the load order snapshot, and one stream.
The backend is always running, so no view has a mode for its absence; a disconnect is an error
the views surface.

## What is left out

Deliberately absent, so that every arrow that is drawn stays legible: Python scripts, which
are a second HTTP client of the same endpoints (ADR-0024); the repair engine (ADR-0043); and
MO2's own UI beyond the trees Modbench renders.

## Maintaining it

Edit in diagrams.net and keep cell ids stable so a diff reads as a change to one box or one
arrow. A new module is a box with its interface and what it hides. A new payload is an arrow
labelled with what moves, in the colour of its gesture. When a refactor lands that makes a page
false, the page changes in the same change, and the decision it cites changes with it.
