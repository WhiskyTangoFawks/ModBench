import type { Instance } from '../instanceLoader/instance';

/** A window whose focus never changes, for a test whose subject is not the recompute's triggers. */
export const STEADY_WINDOW: ConstructorParameters<typeof Instance>[0]['window'] = {
  state: { focused: true },
  onDidChangeWindowState: () => ({ dispose: () => {} }),
};
