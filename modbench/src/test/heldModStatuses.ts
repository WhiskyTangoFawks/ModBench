import type { FileRead } from '../instanceAdapter/instanceAdapter';
import type { ModStatus } from '../manifestAdapter/manifestAdapter';
import { ModStatuses } from '../modStatus/modStatuses';
import { fakeInstanceAdapter } from './fakeInstanceAdapter';

type Entries = ReadonlyMap<string, FileRead<readonly string[]>>;

interface Derived {
  /** Each mod's status as the derivation read it, an unreadable one among them. */
  readonly statuses: readonly ModStatus[];
  /** The files of each mod's folder that a package holds. */
  readonly packaged?: Readonly<Record<string, readonly string[]>>;
  /** The entries of each mod's archives that no package holds. */
  readonly entries?: Readonly<Record<string, Entries>>;
}

/** Mod status as a derivation leaves it, each derivation a test hands it: a mod's last good status is the last that was readable. */
export class HeldModStatuses extends ModStatuses {
  private held: Required<Derived> = { statuses: [], packaged: {}, entries: {} };
  private readonly lastGood = new Map<string, ModStatus>();
  private readonly listeners = new Set<(mods: 'every' | ReadonlySet<string>) => void>();

  constructor(first: Derived = { statuses: [] }) {
    super(fakeInstanceAdapter().adapter, () => undefined, () => Promise.resolve([]));
    this.hold(first);
  }

  /** A derivation lands `next`, and tells each listener every mod changed. */
  becomes(next: Derived): void {
    this.hold(next);
    for (const listener of this.listeners) listener('every');
  }

  override current(): Promise<ReadonlyMap<string, ModStatus>> {
    return Promise.resolve(new Map(this.held.statuses.map((status) => [status.mod, status])));
  }

  override of(mod: string): ModStatus | undefined {
    return this.lastGood.get(mod);
  }

  override heldByPackage(mod: string): ReadonlySet<string> {
    return new Set(this.held.packaged[mod] ?? []);
  }

  override entriesNoPackageHolds(mod: string): Entries {
    return this.held.entries[mod] ?? new Map();
  }

  override onDidChange(listener: (mods: 'every' | ReadonlySet<string>) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  private hold({ statuses, packaged = this.held.packaged, entries = this.held.entries }: Derived): void {
    this.held = { statuses, packaged, entries };
    for (const status of statuses.filter(({ unreadable }) => unreadable === undefined)) this.lastGood.set(status.mod, status);
  }
}
