import * as vscode from 'vscode';
import { foldPath, type ConflictEntry } from './fileConflictIndex';

/** #447: badges + tints a Plugins-tree row that is a **file override** (Resolution stack, root
 *  `CONTEXT.md`) — its plugin filename is provided by more than one enabled mod, per
 *  `PluginListProvider.fileOverrides()`. The git-modified idiom (badge glyph + themed color) via
 *  the same `FileDecorationProvider` mechanism `ImplicitMasterDecorationProvider` /
 *  `HiddenDownloadDecorationProvider` / `OverwriteDecorationProvider` already use for row color,
 *  keyed on the `resourceUri` `PluginNode` sets only when it carries a `fileOverride` (see
 *  `PluginNode`'s own doc comment for why that's conditional, never unconditional).
 *
 *  The badge/tooltip here are deliberately minimal — a provider count, no names — because
 *  `PluginNode`'s own description/tooltip (set directly in its constructor) already carries the
 *  rich "N mods — winner: X, naming every provider" text; VS Code merges a `FileDecoration` onto a
 *  row it already renders, it never replaces what's there. Color: `gitDecoration.modifiedResourceForeground`,
 *  matching `RecordDecorationProvider`'s own git-modified idiom (#428) — the one
 *  `FileDecorationProvider` in this codebase that already pairs a badge with a themed color. Badge
 *  glyph (provider count, capped at two characters) and color are a visual call, not an
 *  architecturally load-bearing choice — provisional, like `HiddenDownloadDecorationProvider`'s
 *  own admitted pick.
 *
 *  Stateless per call, same as the three siblings above — every state change that could add/remove
 *  a file override already goes through `PluginListProvider.invalidate()`, whose
 *  `onDidChangeTreeData` redraw re-queries this provider for each redrawn URI. `fileOverrides` is
 *  read lazily (live, not a snapshot) — `PluginListProvider.fileOverrides()`. A linear scan over
 *  its values (small in practice — real load orders rarely have more than a handful of contested
 *  filenames at once), never a second path-keyed structure to keep in sync: `PluginNode.resourceUri`
 *  already IS one of these entries' own `winner` path, so there is exactly one source of truth. */
export class FileOverrideDecorationProvider implements vscode.FileDecorationProvider {
  constructor(private readonly fileOverrides: () => ReadonlyMap<string, ConflictEntry>) {}

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const target = foldPath(uri.fsPath);
    for (const entry of this.fileOverrides().values()) {
      if (foldPath(entry.winner) !== target) continue;
      const count = entry.providers.length;
      return {
        badge: count > 9 ? '9+' : String(count),
        color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
        tooltip: `File override: ${count} mods provide this plugin`,
      };
    }
    return undefined;
  }
}
