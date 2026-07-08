# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root — it maps the two bounded contexts and their language boundary. Read the `CONTEXT.md` of each context relevant to the topic:
  - **Editing** context → `CONTEXT.md` (repo root)
  - **Mod Management** context → `modbench/src/modmanager/CONTEXT.md`
- **`docs/adr/`** — system-wide architectural decisions. Read ADRs that touch the area you're about to work in.
- **`docs/specs/`** — living surface specs for each Modbench UI surface (present-tense behavior).

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## Layout

This is a **multi-context** repo:

```
/
├── CONTEXT-MAP.md                          ← context map (start here)
├── CONTEXT.md                              ← Editing context glossary
├── docs/adr/                               ← system-wide decisions
├── docs/specs/                             ← per-UI-surface living specs
└── modbench/src/modmanager/
    └── CONTEXT.md                          ← Mod Management context glossary
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant context's `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids — in particular, "mod" is forbidden in the Editing context and "record"/"FormKey" is absent from Mod Management.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
