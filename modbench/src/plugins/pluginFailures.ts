// ADR-0019; plugins.md, Reporting, story 1.

import type { PluginLoadFailure } from '../client';

export interface FailureSink {
  log: (msg: string) => void;
  warn: (msg: string) => void;
}

export function reportSkippedPlugins(
  failures: readonly PluginLoadFailure[],
  sink: FailureSink,
): void {
  if (failures.length === 0) return;
  for (const f of failures) {
    sink.log(`skipped plugin '${f.name}': ${f.reason}`);
  }
  const names = failures.map((f) => f.name).join(', ');
  sink.warn(
    `${failures.length} plugin(s) were skipped — their records are NOT loaded: ${names}. ` +
      'See the Modbench output for details.',
  );
}
