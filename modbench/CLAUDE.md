# modbench

TypeScript VS Code extension. Root [CLAUDE.md](../CLAUDE.md) for project-wide rules.

```bash
# one box while iterating
npx tsc -b src/<box>
npx vitest run src/<box>   # skips the cross-cutting scans in src/test/; npm run test:unit runs them
```

- The instance value is the Instance loader's in-memory read of the instance and the game's Data/ folder. Views read it; a command is handed the slice it needs as an argument.
- A gesture belongs to the object it acts on, never to a view ([commands.md](../docs/architecture/commands.md)). A view shows objects and offers their gestures. A gesture Modbench handles is a command of the core box for its object; a gesture mEdit handles is a call through the mEdit client, from a box that references it.
- A view takes every path it shows or opens from the instance value and never builds one: the box that owns a path answers it, the Instance adapter for the instance's, and a lint rule keeps `node:path` out of every view.
- The generated schema is the frontend type: `src/client/MEditClient.ts`, `src/client/apiClient.ts` and `webview/src/types.ts` alias `components['schemas'][…]`, and a new wire field is a C# model change plus `/regenerate-api`. A hand-written type is a transform of the wire type, never a mirror of it.
- A wait in a test is on a value: a fake clock advances time, or the delay is injected as zero. A check that something never happens waits for a later event ordered after it. Where no such event exists, it waits a fixed window.
- A rule ESLint holds is tested by ESLint.
- A removal is proved by the build; each test asserts what the code does.
