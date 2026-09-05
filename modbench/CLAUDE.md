# modbench

TypeScript VS Code extension. Root [CLAUDE.md](../CLAUDE.md) for project-wide rules; the ADR
named on a line is the full statement.

- The generated schema is the frontend type: `ApiClient.ts` and `webview/src/types.ts` alias
  `components['schemas'][…]`, and a new wire field is a C# model change plus `/regenerate-api`.
  A hand-written type is a transform of the wire type, never a mirror of it.
- Every UI surface has a living spec in `docs/specs/`; a UI change updates its spec in the same
  change.
- A site that both logs and toasts goes through the injected `makeReporter`; the severity table is ADR-0026.
