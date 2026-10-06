interface SelectionView<T> {
  readonly selection: readonly T[];
  onDidChangeSelection: (listener: (e: { selection: readonly T[] }) => unknown) => { dispose: () => unknown };
}

/** VS Code reports no selection from a tree's change until the rebuilt tree hands its rows back, so
 *  the user's last selection answers as the rows `shown` finds for it: a gone or hidden row is out. */
export function survivingSelection<T>(
  view: SelectionView<T>, shown: (row: T) => T | undefined,
): { rows: () => readonly T[]; dispose: () => void } {
  let held: readonly T[] = view.selection;
  const subscription = view.onDidChangeSelection((e) => { held = e.selection; });
  return {
    rows: () => {
      if (view.selection.length > 0) return view.selection;
      held = held.flatMap((row) => shown(row) ?? []);
      return held;
    },
    dispose: () => { subscription.dispose(); },
  };
}
