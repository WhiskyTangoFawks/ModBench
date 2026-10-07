import { expect } from 'vitest';
import type { Instance, InstanceValue } from '../../instanceLoader/instance';
import { present } from '../../ports/present';
import { watchers, type FakeWatcher } from './fakeVscodeWatcher';

export const watcherFor = (glob: string): FakeWatcher => {
  const found = watchers.filter((w) => w.pattern === glob);
  expect(found).toHaveLength(1);
  return present(found[0], `the sole watcher registered for "${glob}"`);
};

export function pastSequence(instance: Instance, sequence: number): Promise<InstanceValue> {
  if (instance.sequence > sequence) return Promise.resolve(instance.value);
  return new Promise((resolve) => {
    const subscription = instance.subscribe((value, seq) => {
      if (seq <= sequence) return;
      subscription.dispose();
      resolve(value);
    });
  });
}
