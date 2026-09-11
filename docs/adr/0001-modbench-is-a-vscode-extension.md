# Modbench is a VS Code extension

The goal is not a new modding tool. It is to use the power tools and workflows a professional
developer already uses every day, an IDE with version control and tooling, for modding. So
Modbench is a VS Code extension, not a standalone application. That buys, free and open source:

- the bulk of the UI, with every configuration and customization VS Code supports;
- program lifecycle and Linux compatibility;
- a battle-tested base millions of people use daily;
- VS Code's agent framework;
- extensibility through other extensions.

The cost is accepted: it is less user-friendly than a purpose-built application. The target
audience is super users and workflows with significant complexity, the kind of work it takes to
maintain a large modlist.

## Alternatives rejected

- **A standalone desktop application.** Every item above is rebuilt from scratch. People have
  tried to replace the ten-year-old tooling before and failed on exactly that.
