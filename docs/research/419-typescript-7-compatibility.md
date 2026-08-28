# #419 — TypeScript 7 upgrade spike: compatibility findings

Investigation for [#419](https://github.com/WhiskyTangoFawks/ModBench/issues/419) ("Upgrade to
Typescript 7"). Outcome: **Blocked**. Two of the four tools `modbench/` depends on for its
TypeScript toolchain hard-block installing `typescript@7` today; `tsc` itself is fully compatible
and faster, but that alone isn't a completion per the issue's own criteria (all four gates must
pass). No source or dependency changes are landed by this investigation — `modbench/package.json`
still pins `typescript ^5.3.0` (resolves to `5.9.3` as installed).

## What TS7 is, as of this spike

TypeScript 7.0 (the Go-native compiler, project "typescript-go"/`tsgo`) reached GA as `7.0.2` on
npm (`latest` dist-tag), so this spike tests the real stable release, not the
`@typescript/native-preview` preview line the issue names as a fallback — that fallback clause
doesn't apply. TS 7.0 ships **without a stable programmatic compiler API**; Microsoft's own target
for that API is TypeScript 7.1.

## Compatibility table

| # | Tool | Version tested | Result | Failure / evidence | Upstream tracking | Earliest revisit condition |
|---|---|---|---|---|---|---|
| 1 | `tsc -p tsconfig.json --noEmit` (extension) | `typescript@7.0.2` | **PASS** | Exit 0, zero diagnostics, run via `npx --package typescript@7.0.2 tsc -p tsconfig.json --noEmit` against the real source tree | — | already viable in isolation |
| 2 | `tsc -p webview/tsconfig.json --noEmit` | `typescript@7.0.2` | **PASS** | Exit 0, zero diagnostics, same method | — | already viable in isolation |
| 3 | `tsc -p tsconfig.integration.json` (emitting) | `typescript@7.0.2` | **PASS** | Exit 0; emitted all 13 expected `.js` files to a scratch outDir — confirms JS emit works in the native GA line, which the issue flagged as unconfirmed | — | already viable in isolation |
| 4 | `typescript-eslint` type-aware lint (`npm run lint`) | `typescript-eslint@8.60.1` (pinned) / `8.68.0` (latest today) | **BLOCKED** | Real local `npm install --save-dev typescript@7.0.2` (no override flags) → `ERESOLVE`, exit 1: `peer typescript@">=4.8.4 <6.1.0" from @typescript-eslint/parser@8.68.0` (and from `@typescript-eslint/eslint-plugin`) — both current and latest published typescript-eslint declare the same peer cap, so this isn't version-lag, it's a stated exclusion | [typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940) (tracking; maintainers cite ≥3 structural blockers — ESLint's parser isn't async-capable, `tsgo` will likely be WASM/async-only, `synckit` has serialization difficulties), [#12518](https://github.com/typescript-eslint/typescript-eslint/issues/12518) (closed as duplicate/not-planned), [#12521](https://github.com/typescript-eslint/typescript-eslint/issues/12521) + merged [#12529](https://github.com/typescript-eslint/typescript-eslint/pull/12529) (adds a friendly "TS7 detected, unsupported" warning rather than support) | TS 7.1 ships its stable programmatic compiler API (Microsoft's stated target, described as "several months out" as of Aug 2026) **and** typescript-eslint lands support on top of it — maintainers describe this as unlikely within the next 1–2 typescript-eslint majors, no committed version/date |
| 5 | `openapi-typescript` (`npm run generate-api`) | `openapi-typescript@7.13.0` (pinned `^7.13.0`, currently latest) | **BLOCKED** | Same `npm install` run: `peer typescript@"^5.x" from openapi-typescript@7.13.0` | [openapi-typescript#2841](https://github.com/openapi-ts/openapi-typescript/issues/2841) ("doesn't work with Typescript 7", opened 2026-07-09, open/unresolved, no fix version) | Upstream release compatible with TS7's (eventual, 7.1+) programmatic API — no committed version/date. Because the dependency resolution itself fails, the live `generate-api` run against a fresh backend was never attempted — blocked before a backend would even matter, noted per the issue's instruction to state this rather than skip silently |
| 6 | esbuild / vite / vitest (transpile/bundle, non-`tsc` paths) | as pinned (`esbuild ^0.28.0`, `vite ^5.0.0`, `vitest ^2.1.9`) | **Unaffected (verified)** | Grepped installed manifests: `esbuild` and `vitest` have zero references to `typescript` anywhere in `package.json`; `vite`'s only match is an unrelated `prettier --parser typescript` script string. None declare a `typescript` dependency or peerDependency — confirms they use their own internal TS-syntax stripping, not the `typescript` package's compiler API. Not run live against a resolved TS7 tree (impossible while rows 4–5 block resolution); the dependency-graph result is the direct verification the issue asked for | — | n/a |
| 7 | `@vscode/vsce package` dry run | `@vscode/vsce@3.9.2` (pinned) | **Unaffected / not applicable** | `vsce` declares `typescript: ~5.9.0` only in its own `devDependencies` (its internal build-time use, already compiled), never as a `peerDependency` against the host project — so it enforces nothing about our TS version. Not run live against a resolved TS7 tree for the same structural reason as row 6 | — | n/a |

## Headline metric (the issue's requested before/after)

Per-gate type-check timing, same machine, same source tree, isolated single-gate runs (not the
full `npm run build` pipeline, to isolate `tsc` from `esbuild`/`vite`):

| Gate | TS 5.9.3 (currently pinned) | TS 7.0.2 (native) | Speedup |
|---|---|---|---|
| `tsc -p tsconfig.json --noEmit` | 3.156s real | 0.748s real | ~4.2x |
| `tsc -p webview/tsconfig.json --noEmit` | 2.513s real | 0.752s real | ~3.3x |

Both diagnostics sets are empty under both compilers — TS7 surfaces no new type errors against this
source tree.

## Node/engine requirements

Not evaluated as a blocker and no change needed for the parts that do work: `typescript@7.0.2` ran
fine under the currently-installed Node `v22.23.2`. Since the upgrade isn't landing, no engines
bump is proposed.

## Why this is Blocked, not Green

The issue's Green criterion is all four named gates passing; two (`npm run lint`'s type-aware
typescript-eslint config, `npm run generate-api`'s openapi-typescript) cannot even resolve their
dependencies against `typescript@7`, let alone run, as of 2026-08-28. This is not a lag/staleness
problem — both tools' current *latest* published releases declare the same TS7 exclusion, and both
have open upstream tracking issues confirming it's structural (dependency on TS's programmatic
compiler API, which TS 7.0 doesn't yet expose). Per repo policy, no suppressions or gate-loosening
were used to force a green.

## Method notes (for reproducibility)

- `tsc` rows (1–3) were run via `npx --package typescript@7.0.2 tsc ...`, which fetches and pins
  TS7.0.2 for that single invocation without touching `modbench/package.json`,
  `package-lock.json`, or `node_modules` — verified via `npx --package typescript@7.0.2 tsc
  --version` printing `Version 7.0.2` before relying on it.
- The blocked rows (4–5) were confirmed via one real `npm install --save-dev typescript@7.0.2`
  with no `--legacy-peer-deps`/`--force` override, in the actual worktree, then fully reverted
  (`git status` was clean before and after; `node_modules/typescript` verified back at `5.9.3`
  post-revert since the failed install did not partially mutate it).
