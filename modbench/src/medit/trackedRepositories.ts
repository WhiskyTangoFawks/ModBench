import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginMetadata } from './ApiClient';

/** #414/ADR-0041: tracked *is* the presence of `.git` in the mod folder — a plain filesystem
 *  check, no backend call and no registry, mirroring `SourceRepository.IsTracked` on the backend
 *  side of the same claim. Deliberately no `vscode` import: this stays a pure Node function so it
 *  is testable under Vitest without a VS Code host (modbench/CLAUDE.md's "vscode types stay out of
 *  SessionController/repositories" applies the same way here). Exported (#448): the Stack node's
 *  state entries (source/binary) are tracked-gated the same way — reused rather than re-derived,
 *  never a second `.git`-presence check drifting from this one. */
export function isTracked(modFolder: string): boolean {
  return fs.existsSync(path.join(modFolder, '.git'));
}

/** Every distinct tracked mod folder among `plugins` — the input to the native-git-UI activation
 *  wiring below. Distinct, not one per plugin: a mod folder can hold more than one plugin, and
 *  each must register with `vscode.git` exactly once (AC: "no duplicate SCM registration"). */
export function trackedModFoldersOf(plugins: readonly Pick<PluginMetadata, 'path'>[]): string[] {
  const folders = new Set<string>();
  for (const plugin of plugins) {
    const folder = path.dirname(plugin.path);
    if (isTracked(folder)) folders.add(folder);
  }
  return [...folders];
}

/** Re-registers the native Source Control panel for every tracked mod folder — the `vscode.git`
 *  extension API's `openRepository`, called once per distinct folder (never per plugin: see
 *  `trackedModFoldersOf`). `openRepository` is injected as a plain callback rather than the real
 *  `vscode.git` type so this stays unit-testable; `extension.ts` is the only real caller and
 *  supplies `(folder) => gitApi.openRepository(vscode.Uri.file(folder))`. Deduplicates its own
 *  input too — the AC's contract, not merely a property `trackedModFoldersOf`'s caller happens to
 *  uphold.
 *
 *  #557: resolves to a `Map` of folder → the repository handle `openRepository` returned, instead
 *  of discarding it (the old `Promise<void>` shape). `extension.ts` keeps this map so a
 *  subsequent field edit can prompt the right repository's own `status()` — the missing piece
 *  that left the Source Control panel waiting on a manual Refresh (RecordDecorationProvider.ts's
 *  own #428 Q2 doc comment already named this as "repo-handle plumbing... not this ticket"; #557
 *  is that follow-up, for the outbound direction only). A folder whose `openRepository` call
 *  resolves `null` (the real API's own "declined to open" answer) is omitted rather than stored,
 *  so a later `.status()` lookup can never land on a null handle. */
export async function registerTrackedRepositories<T>(
  openRepository: (modFolder: string) => Promise<T | null | undefined>,
  modFolders: readonly string[],
): Promise<Map<string, T>> {
  const distinct = [...new Set(modFolders)];
  const repositories = new Map<string, T>();
  for (const folder of distinct) {
    const repository = await openRepository(folder);
    if (repository != null) repositories.set(folder, repository);
  }
  return repositories;
}
