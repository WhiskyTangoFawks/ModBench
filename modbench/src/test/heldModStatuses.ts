import { ModStatuses } from '../modStatus/modStatuses';
import type { ModStatus } from '../manifestAdapter/manifestAdapter';
import { fakeInstanceAdapter } from './fakeInstanceAdapter';

/** Mod status as if each status it holds were derived: what it says of a mod, why it shows the last good ones, and the
 *  change it tells. */
export class HeldModStatuses extends ModStatuses {
  /** Why the statuses shown are the last good ones. */
  readonly reasons: string[] = [];
  private readonly statusesHeld = new Map<string, ModStatus>();
  private readonly heard = new Set<(mods: 'every' | ReadonlySet<string>) => void>();

  constructor() {
    super(fakeInstanceAdapter().adapter, () => undefined, () => Promise.resolve([]));
  }

  /** Mod status derived these statuses, and tells the mods `changed` names. */
  answer(statuses: readonly ModStatus[], changed: 'every' | ReadonlySet<string> = 'every'): void {
    for (const status of statuses) this.statusesHeld.set(status.mod, status);
    this.heard.forEach((listener) => { listener(changed); });
  }

  override of(mod: string): ModStatus | undefined {
    return this.statusesHeld.get(mod);
  }

  override onDidChange(listener: (mods: 'every' | ReadonlySet<string>) => void) {
    this.heard.add(listener);
    return { dispose: () => { this.heard.delete(listener); } };
  }

  override lastGoodReasons(): string[] {
    return this.reasons;
  }
}
