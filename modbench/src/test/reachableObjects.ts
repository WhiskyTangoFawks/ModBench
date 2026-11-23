/** Every object `value` reaches through its fields and the entries of its maps and sets, `value` too. */
export function reachableObjects(value: unknown): Set<object> {
  const seen = new Set<object>();
  const stack = [value];
  while (stack.length > 0) {
    const next = stack.pop();
    if ((typeof next !== 'object' && typeof next !== 'function') || next === null || seen.has(next)) continue;
    seen.add(next);
    if (typeof next === 'function') continue;
    const children = next instanceof Map ? [...next].flat() : next instanceof Set ? [...next] : Object.values(next);
    for (const child of children) stack.push(child);
  }
  return seen;
}
