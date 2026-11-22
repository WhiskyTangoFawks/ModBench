import type { InstanceSubscriber, InstanceValue } from '../../instanceLoader/instance';
import { toldOf } from '../../instanceLoader/told';
import { CHECK_THE_DISK } from '../../instanceAdapter/instanceAdapter';

/** The double every provider's row contract needs: `.value` plus `.subscribe`, structurally
 *  compatible with `Instance` without ever constructing one. Shared so a fake `publish`ed
 *  recompute means the same thing in every test. */
export class FakeInstance {
  value: InstanceValue;
  // Defaults to 1 ("already loaded") so every fixture-based test needs no opinion on it; a test
  // of the sequence === 0 ("not read yet") guard passes 0 explicitly.
  sequence: number;
  readFailure: string | undefined;
  private subscribers: { readonly subscriber: InstanceSubscriber; readonly concerns: readonly (keyof InstanceValue)[] | undefined; told?: InstanceValue }[] = [];
  private failureListeners: (() => void)[] = [];
  private redrawListeners: (() => void)[] = [];
  constructor(initial: InstanceValue, sequence = 1) {
    this.value = initial;
    this.sequence = sequence;
  }
  subscribe(subscriber: InstanceSubscriber, concerns?: Readonly<Partial<Record<keyof InstanceValue, true>>>) {
    const subscribed = { subscriber, concerns: concerns && Object.keys(concerns).filter((fact): fact is keyof InstanceValue => fact in this.value), told: this.value };
    this.subscribers.push(subscribed);
    return { dispose: () => { this.subscribers = this.subscribers.filter((s) => s !== subscribed); } };
  }
  // Simulates a landed recompute: publishes to every live subscriber, the way Instance's own
  // watcher-driven recompute does.
  publish(value: InstanceValue, reread = CHECK_THE_DISK): void {
    this.value = value;
    this.readFailure = undefined;
    this.sequence++;
    for (const subscribed of [...this.subscribers]) {
      const before = subscribed.told;
      subscribed.told = value;
      void subscribed.subscriber(value, this.sequence, toldOf(before, value, reread, subscribed.concerns));
    }
  }
  refresh(wrote?: readonly string[]): Promise<void> {
    this.publish(this.value, wrote === undefined ? CHECK_THE_DISK : { named: wrote, disk: false });
    return Promise.resolve();
  }
  onReadFailure(listener: () => void) {
    this.failureListeners.push(listener);
    return { dispose: () => { this.failureListeners = this.failureListeners.filter((l) => l !== listener); } };
  }
  onRedraw(listener: () => void) {
    this.redrawListeners.push(listener);
    return { dispose: () => { this.redrawListeners = this.redrawListeners.filter((l) => l !== listener); } };
  }
  redraw(): void {
    for (const listener of [...this.redrawListeners]) listener();
  }
  // Simulates a recompute that threw: the value and sequence stay put, and the reason is held.
  fail(reason: string): void {
    this.readFailure = reason;
    for (const listener of [...this.failureListeners]) listener();
  }
}
