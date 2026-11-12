/** A workspace that holds every path until `holdsNothing` or `holdsEverything` says otherwise, and tells its listeners. */
export function fakeWorkspace(holding = true) {
  let holds = holding;
  const listeners = new Set<() => void>();
  const set = (now: boolean) => {
    holds = now;
    for (const listener of [...listeners]) listener();
  };
  return {
    holds: () => holds,
    onDidChange: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    holdsNothing: () => { set(false); },
    holdsEverything: () => { set(true); },
  };
}
