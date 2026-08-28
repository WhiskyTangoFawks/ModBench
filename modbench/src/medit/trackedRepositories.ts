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
 *  uphold. */
export async function registerTrackedRepositories(
  openRepository: (modFolder: string) => Promise<unknown>,
  modFolders: readonly string[],
): Promise<void> {
  const distinct = [...new Set(modFolders)];
  for (const folder of distinct) {
    await openRepository(folder);
  }
}
