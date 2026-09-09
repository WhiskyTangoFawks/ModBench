import type { components } from './generated/api';
import type { LoadOrderPluginInput } from './EditingController';
import { reportSkippedPlugins } from './pluginFailures';

/** Each callback is exactly one ADR-0026 surface — `warn` toasts, `log` writes the channel,
 *  `setStatusText` writes the status bar, `notifyConflictsComputed` fires once. */
export interface LoadOrderOutcomeDeps {
  log: (msg: string) => void;
  warn: (msg: string) => void;
  setStatusText: (text: string) => void;
  notifyConflictsComputed: () => void;
}

/** Everything a `reconciled` `putLoadOrder` needs reported once it lands, pulled out of the
 *  load-order sync's own `vscode` wiring so it is testable without a VS Code harness. */
export function reportReconciled(
  plugins: LoadOrderPluginInput[],
  failures: components['schemas']['PluginLoadFailure'][],
  deps: LoadOrderOutcomeDeps,
): void {
  reportSkippedPlugins(failures, deps);
  // Participation is derived — enabled AND winning AND listed — and the snapshot is every copy,
  // so a non-empty one can still have nothing that participates (ADR-0044).
  if (!plugins.some((p) => p.enabled && p.winning && p.slot !== null)) {
    deps.warn(
      'mEdit: The active profile has no enabled plugins — only base-game masters are held. ' +
        'Enable plugins in the mod list (or check the profile\'s plugins.txt).',
    );
  }
  deps.setStatusText(`$(check) mEdit: Ready (${plugins.length} plugin copies)`);
  // The backend answers this PUT only after the winner sweep, so reaching here *is* "conflicts
  // are computed" (ADR-0035).
  deps.notifyConflictsComputed();
}
