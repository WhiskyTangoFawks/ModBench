# modbench

TypeScript VS Code extension. Root [CLAUDE.md](../CLAUDE.md) for project-wide rules.

- The generated schema is the frontend type: `src/client/MEditClient.ts`,
  `src/client/apiClient.ts` and `webview/src/types.ts` alias `components['schemas'][…]`, and
  a new wire field is a C# model change plus `/regenerate-api`. A hand-written type is a transform
  of the wire type, never a mirror of it.
- Every UI surface has a living spec in `docs/specs/`; a UI change updates its spec in the same
  change.
