# Domain Docs

How the engineering skills consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the glossary of nouns. It holds words a general model misjudges: modding words it knows loosely, and ambiguity traps. One heading per term. An `Avoid:` line lists rival words. Verbs are in `docs/architecture/commands.md`.
- **`docs/architecture/`** — the target architecture. `target-architecture.md` says how to read the diagrams. `traces/` holds one sequence diagram per gesture family. `commands.md` indexes every gesture and command with its status and trace. Modules, ports and payloads are defined here and never in `CONTEXT.md`.
- **`docs/adr/`** — system-wide architectural decisions, each stating current truth. Numbering has gaps: a decision that was reversed is deleted, and its story lives in the *Alternatives rejected* section of the ADR that replaced it. ADRs are rewritten in place (pre-alpha — root `CLAUDE.md` § Status). Read the ADRs that touch the area you're about to work in.
- **`docs/architecture/surfaces/`** — one surface spec per view: what the user sees. A gesture's contract is the `.md` beside its trace in `docs/architecture/traces/`. Both are written before the code and never updated to match it. Before building on a surface, read its spec and the traces of its gestures.
- **`docs/research/`** — a mix of reference material that stays live and spikes awaiting disposal; check what's actually there rather than trusting this list. Live reference: `xedit-ux-audit.md` (required reading before any record-editing interaction) and `mod-manager-feature-inventory.md` (MO2/Vortex feature map). A spike is deleted once its decision lands in an ADR.
- **`docs/out-of-scope/`** — the won't-do register. Check it before proposing a feature; if it's there, the answer and the reason are recorded.

## Layout

```
/
├── CONTEXT.md                              ← glossary: nouns (start here)
├── docs/architecture/                      ← target architecture, surface specs, traces, command index
├── docs/adr/                               ← system-wide decisions (gaps = reversed decisions)
├── docs/research/                          ← live reference material
└── docs/out-of-scope/                      ← won't-do register
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as `CONTEXT.md` defines it. Do not use a word from a term's `Avoid:` line for that concept. A word scoped in brackets, such as "override (a placement, not a clash)", stays valid for its other meaning.

If the concept you need isn't in the glossary, either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0008 (masters are derived, never user-declared) — but worth reopening because…_
