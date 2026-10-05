// A record tab's column header names only its plugin's origin, and the Editor reads no instance
// value, so its track and decompile conditions are `origin in` these lists (editor.md, Menus and keys).

import * as vscode from 'vscode';
import type { InstanceValue, InstanceView } from '../instanceLoader/instance';

/** Each plugin origin whose mod has a repository, and each whose mod has none, spelled as the
 *  plugin rows spell them. An origin names its mod's folder (ADR-0012), whatever the case. */
export function modRepositoryContext(
  value: Pick<InstanceValue, 'mods' | 'plugins' | 'trackedMods'>,
): { tracked: string[]; untracked: string[] } {
  const modOf = new Map(value.mods.filter((entry) => entry.kind === 'mod').map((entry) => [entry.name.toLowerCase(), entry.name]));
  const inMods = [...new Set(value.plugins.map((plugin) => plugin.origin))]
    .flatMap((origin) => {
      const mod = modOf.get(origin.toLowerCase());
      return mod === undefined ? [] : [{ origin, tracked: value.trackedMods.has(mod) }];
    });
  return {
    tracked: inMods.filter((entry) => entry.tracked).map((entry) => entry.origin),
    untracked: inMods.filter((entry) => !entry.tracked).map((entry) => entry.origin),
  };
}

/** Publishes the lists as the `modbench.mod.*` context keys, now and on each new value. */
export function showModRepositories(instance: Pick<InstanceView, 'value' | 'subscribe'>): vscode.Disposable {
  const show = (value: InstanceValue) => {
    for (const [name, mods] of Object.entries(modRepositoryContext(value))) {
      void vscode.commands.executeCommand('setContext', `modbench.mod.${name}`, mods);
    }
  };
  show(instance.value);
  return instance.subscribe(show);
}
