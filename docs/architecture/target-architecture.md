# Target architecture: how to read the diagrams

mEdit is the C# service in `MEditService/`; Modbench is the VS Code extension in `modbench/`. [ADR-0014](../adr/0014-modules-are-layered-and-reference-only-downward.md) decides the layers and the rule a reference obeys. [ADR-0015](../adr/0015-edits-reach-the-read-model-through-the-watcher.md) decides how a change flows. [ADR-0013](../adr/0013-mod-management-hands-editing-the-load-order.md) decides the load order the file layer hands the record layer. This file says how to read the pictures.

## The set

- [target-architecture.d2](target-architecture.d2) is the zoom-out and the one place a box is defined. One grid, seven rows for the layers, two columns for the processes, so each mEdit layer sits beside its Modbench twin and means the same thing. A module box carries three lines: its name, `owns:` its responsibility, `hides:` the knowledge no other box holds. What other boxes may call is its public interface in code. A cylinder is a store and carries what it holds; purple is a system of record, green is derived from what sits beside it and can be rebuilt. The zoom-out has no arrows.
- [layers.d2](layers.d2) is the layer rule: which band may reference which, and the named exceptions. The project files hold the references themselves, and the gate holds every one of them, and every trace message, to the rule.
- [traces/](traces/) holds one sequence diagram per flow. Gestures whose arrows are the same share one. Actors are the zoom-out's boxes, imported by name; time runs down; a message is labelled with what moves, never with the call, so a request and its reply are two messages. A note on an actor is what it does between messages.
- [styles.d2](styles.d2) is the shared vocabulary. A box class is its layer; in a trace the actor's colour is the only layer mark. A message class says which kind of payload it is, and a reply takes its request's class. A signal is dashed grey and carries no payload, a watch event or a bare request; a push is dashed purple and names what changed, and the receiver re-reads.

## The layers

Both columns use the same seven names. Drivers: who drives the process. Driving adapters: what turns a driver's gesture into a call. Core: the rules, one command per gesture. Kernel: read by the core, the read model and the repositories. On Modbench it is pure. On mEdit it also holds the load order state. A port lives here when its implementer sits above its callers. Both then reference the kernel, and no reference points up or across. Read model: one per process, derived from the repositories below it and rebuilt from them ([ADR-0015](../adr/0015-edits-reach-the-read-model-through-the-watcher.md)). Repositories: what the core calls to reach a system of record, and the only boxes that read or write one. Systems of record: the files that are the truth.

## The rule is the reference list

A box is a project. Its references are the project file's, `tsconfig.json` on Modbench and `.csproj` on mEdit, and the gate holds each one to [layers.d2](layers.d2): a reference points to a lower layer of its column or its column's kernel, or is an exception the rule names. A reference the rule permits is tactical, with its reason in the commit message ([ADR-0014](../adr/0014-modules-are-layered-and-reference-only-downward.md)). A reference the rule forbids is a stop, and a ruling lands in layers.d2 as a named exception, never as a line an agent adds. A kernel box references nothing above it: on mEdit, Ports reads Load order state and the other two read nothing; on Modbench a kernel box references nothing. A composition root, the HTTP endpoints on mEdit and Activation on Modbench, references every box below it and decides nothing. A band's lib holds code that two or more boxes of that band share. A box references its band's lib by the band's rule. A lib references only boxes that every box using it references.

## Why the two columns match

Each process has its own systems of record and one read model over them ([ADR-0015](../adr/0015-edits-reach-the-read-model-through-the-watcher.md)). One watcher, the Instance adapter's, drives both. A change from another tool and a change from Modbench are the same signal, so no trace draws that signal on its own. The watch opens [load-instance](traces/load-instance.d2), and each recompute's snapshot opens [index-load-order](traces/index-load-order.d2) and [detect-external-change](traces/detect-external-change.d2).

## Rules the Modbench column draws

Change flows up only through the one watch and the notification port. The Source adapter owns layout on the mEdit side. The Instance adapter owns it on the Modbench side, and is the one box that reads or writes the instance. Deployment is a boundary of its own: it makes the game see the instance's resolved files, and hides how. The instance decides which file wins each path; deployment decides nothing, and writes only into the game folder, where it removes only what it wrote. A command hands the Instance adapter the change, and the adapter splices it through the file's codec and writes the file whole. The mod manager's codecs are inside its implementation; the game's `plugins.txt` codec is in the kernel. No command reads the Instance loader; a value a command needs, the mods and plugins to sync, or the winners to deploy, arrives as an argument. Every recompute of the instance value takes the same path ([load-instance](traces/load-instance.d2)). Outside the per-release tables, no Modbench file names a game; a source scan holds it. Modbench does not depend on one mod manager. The game owns the format of `plugins.txt`. The mod manager owns every other file in the instance. The Instance adapter is a repository. MO2 is one implementation of it. Only that implementation names MO2. A source scan holds this rule, as it holds game names. Mods, Downloads and Toolbox never see a record.

## What is left out

Deliberately absent, so that every arrow drawn stays legible: the repair engine, and MO2's own UI beyond the trees Modbench renders.

## Rendering

```bash
# from docs/architecture/, with d2 on PATH (https://d2lang.com/tour/install)
d2 target-architecture.d2 target-architecture.svg
d2 layers.d2 layers.svg
for f in traces/*.d2; do d2 "$f" "${f%.d2}.svg"; done
```

The `terrastruct.d2` VS Code extension previews a file live while it is edited.

## Maintaining

- A box is defined once, in the zoom-out. Its id is the project's name; its band is its layer and its process. A trace imports an actor from the zoom-out (`commands: @../target-architecture.medit_core.commands`) and overrides the label to the name alone, so a box renamed or removed in the zoom-out breaks every trace that draws it until the trace follows.
- A module box's caption is three lines: name, `owns:`, `hides:`. Each names a responsibility or a kind of knowledge, never a member or a mechanism. A hides item that a change crosses once becomes a scan, so the judgement is made once. The caption changes when a box is added, split or given another responsibility, and otherwise not at all. A caption line wraps at about 64 characters, because a box is as wide as its longest line. Nothing with an arrow in it belongs in a caption; a flow is a trace.
- Order is declaration order. In the zoom-out a box's row is its layer and its position in the row is where it is written. Both counts are declared, `grid-rows` and `grid-columns: 2`, because a row count alone lets the layout pack cells by width and break the columns.
- Arrows inside a grid are straight lines and their labels collide, so the zoom-out carries none. Every payload lives in a trace.
- A trace declares its actors in the order they first appear in the story and its messages in story order. An actor that is a set of boxes, `every view`, is declared in the trace with the set as its label. A branch, a dialog or a pick is a note on the actor that holds it, not an actor.
- `.claude/skills/validate/check_layers.py` holds every project reference and every trace message to layers.d2. A message it refuses joins two boxes no rule joins. The one exception it does not check is a trace that abbreviates another trace as one message named after it.
- Code that a second box of the same band needs moves into the band's lib. If the band has none, draw one in the zoom-out, with the caption the other libs carry. A lib is the one box an agent adds without asking. A lib that fewer than two boxes use folds back into its user. A copy, or a home in the composition root, is never the way to share code (ADR-0014).
- A new module is a box in the zoom-out with its three lines. A new reference is a line in the project file, with its reason in the commit message. A new payload is a message in the trace of its gesture, in its payload's class. A new flow is a new trace and, if its payload is a new kind, a new class in the styles file.
- A box's `CLAUDE.md` opens with its purpose in plain words, consistent with its caption. A new box gets one, and a caption edit rereads it.
- Render before committing and look at the picture. A change that makes a diagram false changes the diagram in the same change. A change that makes an ADR false goes to the maintainer.
