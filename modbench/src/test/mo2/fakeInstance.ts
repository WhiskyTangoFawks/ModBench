import type { InstanceValue } from '../../instanceLoader/instance';

/** The double every provider's row contract needs: `.value` plus `.subscribe`, structurally
 *  compatible with `Instance` without ever constructing one. Shared so a fake `publish`ed
 *  recompute means the same thing in every test. */
export class FakeInstance {
  value: InstanceValue;
  // Defaults to 1 ("already loaded") so every fixture-based test needs no opinion on it; a test
  // of the sequence === 0 ("not read yet") guard passes 0 explicitly.
  sequence: number;
  readFailure: string | undefined;
  private subscribers: ((value: InstanceValue, sequence: number) => void)[] = [];
  private failureListeners: (() => void)[] = [];
  constructor(initial: InstanceValue, sequence = 1) {
    this.value = initial;
    this.sequence = sequence;
  }
  subscribe(subscriber: (value: InstanceValue, sequence: number) => void) {
    this.subscribers.push(subscriber);
    return { dispose: () => { this.subscribers = this.subscribers.filter((s) => s !== subscriber); } };
  }
  // Simulates a landed recompute: publishes to every live subscriber, the way Instance's own
  // watcher-driven recompute does.
  publish(value: InstanceValue): void {
    this.value = value;
    this.readFailure = undefined;
    this.sequence++;
    for (const subscriber of [...this.subscribers]) subscriber(value, this.sequence);
  }
  onReadFailure(listener: () => void) {
    this.failureListeners.push(listener);
    return { dispose: () => { this.failureListeners = this.failureListeners.filter((l) => l !== listener); } };
  }
  // Simulates a recompute that threw: the value and sequence stay put, and the reason is held.
  fail(reason: string): void {
    this.readFailure = reason;
    for (const listener of [...this.failureListeners]) listener();
  }
}
