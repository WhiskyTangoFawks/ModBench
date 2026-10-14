// modlist-source.md, Status: each mod's folder against its manifest, read again for each mod mEdit pushes as changed
// (mod-status trace).

import * as vscode from 'vscode';
import type { MEditClient, ModStatus } from '../client';
import { failureReason, isReadFailed, type ReadFailed } from '../wire/readFailed';

export type ReadStatus = (mods: readonly string[]) => Promise<readonly ModStatus[] | ReadFailed>;

/** Each mod's status as mEdit last answered it. */
export class ModStatuses implements vscode.Disposable {
  private readonly byMod = new Map<string, ModStatus>();
  // The latest ask that named each mod: an earlier ask that answers last answers nothing.
  private readonly askedIn = new Map<string, number>();
  private asks = 0;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly unsubscribe: () => void;

  constructor(push: Pick<MEditClient, 'onNotification'>, private readonly read: ReadStatus, private readonly log: (line: string) => void) {
    this.unsubscribe = push.onNotification('mod-status-changed', ({ mods }) => { void this.ask(mods); });
  }

  of(mod: string): ModStatus | undefined {
    return this.byMod.get(mod);
  }

  private async ask(mods: readonly string[]): Promise<void> {
    const ask = ++this.asks;
    for (const mod of mods) this.askedIn.set(mod, ask);
    const answer = await this.read(mods);
    if (isReadFailed(answer)) {
      this.log(`Could not read the mods' status: ${failureReason(answer)}`);
      return;
    }
    const answered = new Map(answer.map((status) => [status.mod, status]));
    for (const mod of mods.filter((name) => this.askedIn.get(name) === ask)) {
      const status = answered.get(mod);
      if (status === undefined) this.byMod.delete(mod);
      else this.byMod.set(mod, status);
      if (status?.unreadable) this.log(`The status of "${mod}" could not be read: ${status.unreadable}`);
    }
    this.changed.fire();
  }

  dispose(): void {
    this.unsubscribe();
    this.changed.dispose();
  }
}

const counted = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

// modlist-source.md, Status, story 1.
const differs = ({ differing, namedByNoLine, gone }: ModStatus): boolean => differing.length + namedByNoLine.length + gone.length > 0;

/** What a mod row's description says of its status (mods.md, A row, Mod). */
export function statusDescription(status: ModStatus): string | undefined {
  const state = status.noManifest ? 'no manifest' : differs(status) ? 'differs' : undefined;
  const unprovided = status.noProvider.length > 0 ? `${counted(status.noProvider.length, 'file', 'files')} with no provider` : undefined;
  return [state, unprovided].filter((part) => part !== undefined).join(' · ') || undefined;
}

/** What a mod row's tooltip says of the files its folder lacks (modlist-source.md, Status, story 4). */
export const lackedLine = ({ gone }: ModStatus): string | undefined =>
  (gone.length > 0 ? `its folder lacks ${counted(gone.length, 'file', 'files')} its manifest names` : undefined);

/** Each file of the mod whose row says differs, by its path in the mod. */
export const differingFiles = ({ differing, namedByNoLine }: ModStatus): ReadonlySet<string> => new Set([...differing, ...namedByNoLine]);

/** Whether the mod counts in the view's badge (modlist-source.md, Status, story 5). */
export const countsInBadge = (status: ModStatus): boolean => status.noManifest || differs(status);
