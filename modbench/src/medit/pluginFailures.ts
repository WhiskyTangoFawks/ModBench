// A plugin copy the reconcile could not open or index is a row in an error state: its records are
// missing from the load order, so ADR-0019's integrity tier forbids silence — warn and log every
// reason.

import type { components } from './generated/api';

export interface FailureSink {
  log: (msg: string) => void;
  warn: (msg: string) => void;
}

export function reportSkippedPlugins(
  failures: ReadonlyArray<components['schemas']['PluginLoadFailure']>,
  sink: FailureSink,
): void {
  if (failures.length === 0) return;
  for (const f of failures) {
    sink.log(`skipped plugin '${f.name}': ${f.reason}`);
  }
  const names = failures.map((f) => f.name).join(', ');
  sink.warn(
    `mEdit: ${failures.length} plugin(s) were skipped — their records are NOT loaded: ${names}. ` +
      `See the 'mEdit' output for details.`,
  );
}
