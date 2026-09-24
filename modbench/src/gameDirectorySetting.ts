// The setting that overrides where the game is, editable while Modbench runs. The Instance
// watches files and takes a resolver, so the composition root turns an edit into the same
// recompute Refresh's re-read runs.

export const GAME_DIRECTORY_SECTION = 'modbench.mods.gameDirectory';

/** The Toolbox's own settle: a burst of edits (a pasted path, keystroke by keystroke) becomes
 *  one recompute, as a burst of file events does under the Instance's own settle. */
export const SETTING_SETTLE_MS = 200;

/** VS Code's `ConfigurationChangeEvent`, as much of it as the trigger reads. */
export interface ConfigChangeEvent {
  affectsConfiguration(section: string): boolean;
}

export interface Subscription {
  dispose(): void;
}

/** Subscribes `refresh` to the game-directory setting: one call per burst, after the settle. */
export function refreshOnGameDirectoryChange(
  onConfigChange: (listener: (e: ConfigChangeEvent) => void) => Subscription,
  refresh: () => Promise<unknown>,
): Subscription {
  let settle: ReturnType<typeof setTimeout> | undefined;
  const subscription = onConfigChange((e) => {
    if (!e.affectsConfiguration(GAME_DIRECTORY_SECTION)) return;
    clearTimeout(settle);
    settle = setTimeout(() => void refresh(), SETTING_SETTLE_MS);
  });
  return {
    dispose: () => {
      clearTimeout(settle);
      subscription.dispose();
    },
  };
}
