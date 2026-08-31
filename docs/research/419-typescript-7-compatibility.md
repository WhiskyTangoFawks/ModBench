# TypeScript 7 upgrade spike: compatibility findings

Outcome (as of 2026-08-28): **Blocked**. `tsc` 7 itself is fully compatible and ~4x faster,
but two of the four toolchain gates hard-block installing `typescript@7`. `modbench/package.json`
stays pinned at `typescript ^5.3.0`.

TypeScript 7.0 is the Go-native compiler ("typescript-go"/`tsgo`), GA as `7.0.2` on npm. It ships
**without a stable programmatic compiler API**; Microsoft targets that API for TypeScript 7.1.

## Compatibility table

| Tool | Result | Evidence / revisit condition |
|---|---|---|
| `tsc -p tsconfig.json --noEmit` (extension) | **PASS** | `typescript@7.0.2`: exit 0, zero diagnostics |
| `tsc -p webview/tsconfig.json --noEmit` | **PASS** | Same |
| `tsc -p tsconfig.integration.json` (emitting) | **PASS** | Emitted all 13 expected `.js` files — JS emit works in the native GA line |
| `typescript-eslint` type-aware lint (`npm run lint`) | **BLOCKED** | `npm install typescript@7.0.2` fails `ERESOLVE`: parser and plugin declare `peer typescript@">=4.8.4 <6.1.0"` — a stated exclusion in the latest release, not version lag. Upstream ([typescript-eslint issue 10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)) cites structural blockers (ESLint's parser is not async-capable; `tsgo` likely WASM/async-only; `synckit` serialization). Revisit when TS 7.1 ships its stable compiler API **and** typescript-eslint supports it — no committed version/date |
| `openapi-typescript` (`npm run generate-api`) | **BLOCKED** | Same install run: `peer typescript@"^5.x" from openapi-typescript@7.13.0`. Upstream: [openapi-typescript issue 2841](https://github.com/openapi-ts/openapi-typescript/issues/2841), open, no fix version. Resolution fails before a live `generate-api` run could even start |
| esbuild / vite / vitest | **Unaffected (verified)** | No `typescript` dependency or peerDependency in any of their manifests — they strip TS syntax internally, never call the compiler API |
| `@vscode/vsce package` | **Unaffected** | `vsce`'s `typescript` is its own devDependency, never a peer against the host project |

## Timing (the headline metric)

Isolated single-gate type-check runs, same machine, same tree; both compilers produce empty
diagnostics (TS7 surfaces no new type errors):

| Gate | TS 5.9.3 | TS 7.0.2 | Speedup |
|---|---|---|---|
| `tsc -p tsconfig.json --noEmit` | 3.156s | 0.748s | ~4.2x |
| `tsc -p webview/tsconfig.json --noEmit` | 2.513s | 0.752s | ~3.3x |

Node: `typescript@7.0.2` ran fine under installed Node `v22.23.2`; no engines bump needed.

## Why Blocked, not Green

Two gates cannot even resolve their dependencies against `typescript@7`. Both tools' *latest*
releases declare the TS7 exclusion, and both upstream trackers confirm it is structural — a
dependency on TS's programmatic compiler API, which TS 7.0 does not expose. No suppressions or
gate-loosening were used to force a green.
