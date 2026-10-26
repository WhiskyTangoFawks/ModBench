// modlist-repository.md, Status: each mod's folder against its manifest, read again for each mod mEdit pushes as changed
// (mod-status trace), and for every mod when the stream opens again.

import * as vscode from 'vscode';
import type { MEditClient, ModStatus, ReadModStatus } from '../client';
import { messageLine } from '../drivingLib/messageLine';
import type { SyncMessage } from '../drivingLib/syncFailureReport';
import { failureReason, isReadFailed } from '../wire/readFailed';

/** Each mod's status as mEdit last answered it. A read that fails keeps the last good one, and says so on the view's
 *  message line and once in the Output (common.md, Reporting). */
export class ModStatuses implements SyncMessage, vscode.Disposable {
  private readonly byMod = new Map<string, ModStatus>();
  private readonly askedIn = new Map<string, number>();
  private asks = 0;
  private readFailure: string | undefined;
  private readonly unreadable = new Map<string, string>();
  private readonly statCacheNotWritten = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly messageChanged = new vscode.EventEmitter<void>();
  private readonly unsubscribes: (() => void)[];

  constructor(
    client: Pick<MEditClient, 'onNotification'>, private readonly readStatus: ReadModStatus, private readonly log: (line: string) => void,
  ) {
    this.unsubscribes = [
      client.onNotification('mod-status-changed', ({ mods: changed }) => { void this.ask(changed); }),
    ];
  }

  of(mod: string): ModStatus | undefined {
    return this.byMod.get(mod);
  }

  message(): string | undefined {
    const failures = [
      ...(this.readFailure === undefined ? [] : [`the mods' status could not be read: ${this.readFailure}`]),
      ...[...this.unreadable].map(([mod, why]) => `the status of "${mod}" could not be read: ${why}.`),
    ];
    const unwritten = [...this.statCacheNotWritten].map(([mod, why]) => `The stat cache of "${mod}" could not be written: ${why}.`);
    return messageLine(failures.length === 0 ? undefined : `Showing the last good read: ${failures.join(' ')}`, ...unwritten);
  }

  onMessageChanged(listener: () => void): vscode.Disposable {
    return this.messageChanged.event(listener);
  }

  private async ask(mods: readonly string[]): Promise<void> {
    const ask = ++this.asks;
    for (const mod of mods) this.askedIn.set(mod, ask);
    const answer = await this.readStatus(mods);
    if (isReadFailed(answer)) {
      this.readFailed(failureReason(answer));
      return;
    }
    this.readFailed(undefined);
    const answered = new Map(answer.map((status) => [status.mod, status]));
    for (const mod of mods.filter((name) => this.askedIn.get(name) === ask)) this.hold(mod, answered.get(mod));
    this.changed.fire();
    this.messageChanged.fire();
  }

  private readFailed(reason: string | undefined): void {
    if (reason === this.readFailure) return;
    this.readFailure = reason;
    this.messageChanged.fire();
  }

  private hold(mod: string, status: ModStatus | undefined): void {
    if (status?.unreadable) {
      const { why } = status.unreadable;
      if (this.unreadable.get(mod) !== why) this.log(`The status of "${mod}" could not be read: ${why}`);
      this.unreadable.set(mod, why);
      return;
    }
    this.unreadable.delete(mod);
    if (status === undefined) this.byMod.delete(mod);
    else this.byMod.set(mod, status);
    const unwritten = status?.statCacheNotWritten ?? undefined;
    if (unwritten !== undefined && this.statCacheNotWritten.get(mod) !== unwritten) this.log(`"${mod}": the stat cache could not be written: ${unwritten}`);
    if (unwritten === undefined) this.statCacheNotWritten.delete(mod);
    else this.statCacheNotWritten.set(mod, unwritten);
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.changed.dispose();
    this.messageChanged.dispose();
  }
}

const counted = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

// modlist-repository.md, Status, stories 1 and 6.
const differs = ({ differing, namedByNoLine, gone, metadataDiffers }: ModStatus): boolean => differing.length + namedByNoLine.length + gone.length > 0 || metadataDiffers;

function stateOf(status: ModStatus): string | undefined {
  if (status.noManifest) return 'no manifest';
  return differs(status) ? 'differs' : undefined;
}

/** What a mod row's description says of its status (mods.md, A row, Mod). */
export function statusDescription(status: ModStatus): string | undefined {
  const state = stateOf(status);
  const notHeld = status.notInPackage.length > 0 ? `${counted(status.notInPackage.length, 'file', 'files')} its package does not hold` : undefined;
  const otherBytes = status.otherBytes.length > 0 ? `${counted(status.otherBytes.length, 'file', 'files')} its package holds with other bytes` : undefined;
  const noHost = status.noHost ? 'its package has no host' : undefined;
  return [state, notHeld, otherBytes, noHost].filter((part) => part !== undefined).join(' · ') || undefined;
}

/** What a separator row's description says of its status (mods.md, A row, Separator). */
export const separatorDescription = stateOf;

/** What a mod row's tooltip says of the files its folder lacks (modlist-repository.md, Status, story 4). */
export const lackedLine = ({ gone }: ModStatus): string | undefined =>
  (gone.length > 0 ? `its folder lacks ${counted(gone.length, 'file', 'files')} its manifest names` : undefined);

/** Each file of the mod whose row says differs, by its path on disk. */
export const differingFiles = ({ differing, namedByNoLine }: ModStatus): ReadonlySet<string> => new Set([...differing, ...namedByNoLine]);

/** Whether the mod counts in the view's badge (modlist-repository.md, Status, story 5). */
export const countsInBadge = (status: ModStatus): boolean => status.noManifest || differs(status);
