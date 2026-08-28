# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root — it maps the two bounded contexts and their language boundary. Read the `CONTEXT.md` of each context relevant to the topic:
  - **Editing** context → `CONTEXT.md` (repo root)
  - **Mod Management** context → `modbench/src/modmanager/CONTEXT.md`
- **`docs/specs/`** — living surface specs, one per Modbench UI surface (present-tense behavior). `docs/specs/README.md` indexes them with status. Before building on a surface, read its spec; when an initiative changes behavior, update the spec first.
- **`docs/adr/`** — system-wide architectural decisions, each stating current truth. Numbering has gaps: a decision that was reversed is deleted, and its story lives in the *Alternatives rejected* section of the ADR that replaced it. ADRs are rewritten in place (pre-alpha — root `CLAUDE.md` § Status). Read the ADRs that touch the area you're about to work in.
- **`docs/research/`** — reference material that stays live: `xedit-ux-audit.md` (required reading before any record-editing interaction) and `mod-manager-feature-inventory.md` (MO2/Vortex feature map). A spike is deleted once its decision lands in an ADR.
- **`docs/out-of-scope/`** — the won't-do register. Check it before proposing a feature; if it's there, the answer and the reason are recorded.

## Layout

```
/
├── CONTEXT-MAP.md                          ← context map (start here)
├── CONTEXT.md                              ← Editing context glossary
├── docs/adr/                               ← system-wide decisions (gaps = reversed decisions)
├── docs/specs/                             ← per-UI-surface living specs (+ README index)
├── docs/research/                          ← live reference material
├── docs/out-of-scope/                      ← won't-do register
└── modbench/src/modmanager/
    └── CONTEXT.md                          ← Mod Management context glossary
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant context's `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids — in particular, "mod" is forbidden in the Editing context and "record"/"FormKey" is absent from Mod Management.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0038 (masters are derived, never user-declared) — but worth reopening because…_
