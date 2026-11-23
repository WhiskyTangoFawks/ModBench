import { filesChanged, type FilesChanged } from './filesChanged';
import type { InstanceValue, Reread, Told } from './instance';

/** Whether `key` names a fact of `value`. */
export const isFactOf = (value: InstanceValue) => (key: string): key is keyof InstanceValue => key in value;

/** `reread`, told with `value` to a subscriber that was told `before` last and reads `concerns`, or every fact. */
export function toldOf(before: InstanceValue, value: InstanceValue, reread: Reread, concerns: readonly (keyof InstanceValue)[] | undefined): Told {
  const reads: Partial<Record<keyof InstanceValue, true>> = {};
  for (const fact of concerns ?? Object.keys(value).filter(isFactOf(value))) reads[fact] = true;
  let changed: FilesChanged | undefined;
  return { ...reread, before, changed: () => (changed ??= filesChanged(before, value, reads)) };
}
