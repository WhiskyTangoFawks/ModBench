# A modding concept that files name is a symbol

A modding concept is a symbol whenever a file Modbench reads names it, and VS Code's language features answer for every symbol as they do for code. The user already knows those features, and a file left naming what is gone breaks the modlist with nothing said.

## Consequences

- A rename carries every reference to what it renames. A reference that cannot follow does not stop the rename: it lands, and a warning names what was left behind, since the rename is the user's choice and the warning keeps the picture true.

## Alternatives rejected

- Each gesture finds and fixes the references it knows. Every gesture repeats the search, and a reference no gesture knows breaks in silence.
- Updating the references is a Modbench script, as a workflow of several gestures is (principles.md, Minimal by default). A rename the user starts is one gesture, and its references following is what it means.
