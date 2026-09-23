# modbench

TypeScript VS Code extension. Root [CLAUDE.md](../CLAUDE.md) for project-wide rules.

```bash
# one box while iterating
npx tsc -b src/<box>
npx vitest run src/<box>   # skips the cross-cutting scans in src/test/; npm run test:unit runs them
```

- The instance value is the Instance loader's in-memory read of the instance and the game's Data/
  folder. Views read it; a command is handed the slice it needs as an argument.
- A gesture belongs to the object it acts on, never to a view
  ([commands.md](../docs/architecture/commands.md)). A view shows objects and offers their gestures;
  each gesture is a command of the core box for its object.
- A view takes every path it shows or opens from the instance value and never builds one: the
  Instance adapter owns every path function, and no scan keeps `node:path` out of a view.
- The generated schema is the frontend type: `src/client/MEditClient.ts`,
  `src/client/apiClient.ts` and `webview/src/types.ts` alias `components['schemas'][…]`, and
  a new wire field is a C# model change plus `/regenerate-api`. A hand-written type is a transform
  of the wire type, never a mirror of it.
- A view's spec is its surface in `docs/architecture/surfaces/`; a gesture's contract is the trace
  its row in `docs/architecture/commands.md` names.
