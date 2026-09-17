// The setting that overrides where the game is, editable while Modbench runs. The Instance
// watches files and takes a resolver, so the composition root turns an edit into the same
// recompute a watched file gets, after the same settle.

export const GAME_DIRECTORY_SECTION = 'modbench.mods.gameDirectory';

/** VS Code's `ConfigurationChangeEvent`, as much of it as the trigger reads. */
export interface ConfigChangeEvent {
  affectsConfiguration(section: string): boolean;
}

export interface Subscription {
  dispose(): void;
}

/** Subscribes `refresh` to the game-directory setting. `settleMs` is the Instance's own settle,
 *  so a burst of edits coalesces into one recompute exactly as a burst of file events does. */
export function refreshOnGameDirectoryChange(
  onConfigChange: (listener: (e: ConfigChangeEvent) => void) => Subscription,
  refresh: () => Promise<void>,
  settleMs: number,
): Subscription {
  let settle: ReturnType<typeof setTimeout> | undefined;
  const subscription = onConfigChange((e) => {
    if (!e.affectsConfiguration(GAME_DIRECTORY_SECTION)) return;
    clearTimeout(settle);
    settle = setTimeout(() => void refresh(), settleMs);
  });
  return {
    dispose: () => {
      clearTimeout(settle);
      subscription.dispose();
    },
  };
}
