import type { FileRead } from '../instanceAdapter/instanceAdapter';
import type { ModStatus } from '../manifestAdapter/manifestAdapter';
import { ModStatuses } from '../modStatus/modStatuses';
import { fakeInstanceAdapter } from './fakeInstanceAdapter';

type Entries = ReadonlyMap<string, FileRead<readonly string[]>>;

interface Beside {
  /** The mods the derivation tells each listener changed. */
  readonly changed?: 'every' | ReadonlySet<string>;
  /** The files of each mod's folder that a package holds. */
  readonly packaged?: Readonly<Record<string, readonly string[]>>;
  /** The entries of each mod's archives that no package holds. */
  readonly entries?: Readonly<Record<string, Entries>>;
}

/** Mod status as each derivation a test answers leaves it: a mod's last good status is the last that was readable, and
 *  one that was not says why. */
export class HeldModStatuses extends ModStatuses {
  private statuses: readonly ModStatus[] = [];
  private beside: Beside = {};
  private readonly lastGood = new Map<string, ModStatus>();
  private readonly listeners = new Set<(mods: 'every' | ReadonlySet<string>) => void>();

  constructor() {
    super(fakeInstanceAdapter().adapter, () => undefined, () => Promise.resolve([]));
  }

  /** A derivation reads `statuses`, and what `beside` names, and tells each listener the mods it changed. */
  answer(statuses: readonly ModStatus[], beside: Beside = {}): void {
    this.statuses = statuses;
    this.beside = beside;
    for (const status of statuses.filter(({ unreadable }) => unreadable === undefined)) this.lastGood.set(status.mod, status);
    for (const listener of this.listeners) listener(beside.changed ?? 'every');
  }

  override current(): Promise<ReadonlyMap<string, ModStatus>> {
    return Promise.resolve(new Map(this.statuses.map((status) => [status.mod, status])));
  }

  override of(mod: string): ModStatus | undefined {
    return this.lastGood.get(mod);
  }

  override heldByPackage(mod: string): ReadonlySet<string> {
    return new Set(this.beside.packaged?.[mod] ?? []);
  }

  override entriesNoPackageHolds(mod: string): Entries {
    return this.beside.entries?.[mod] ?? new Map();
  }

  override onDidChange(listener: (mods: 'every' | ReadonlySet<string>) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  override lastGoodReasons(): string[] {
    return this.statuses.flatMap(({ mod, unreadable }) => (unreadable === undefined ? [] : [`the status of "${mod}" could not be read: ${unreadable}.`]));
  }
}
