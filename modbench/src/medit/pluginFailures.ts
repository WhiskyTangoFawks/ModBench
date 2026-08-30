// A plugin copy the reconcile could not open or index (records Mutagen can't parse) is a row in
// an error state (ADR-0044): its records are missing from the load order. Per ADR-0026 (integrity
// tier) this must never be silent — warn the user and log every reason. Fed from `PUT /load-order`'s
// own `LoadOrderResponse.failures`.

export interface FailureSink {
  log: (msg: string) => void;
  warn: (msg: string) => void;
}

export function reportSkippedPlugins(
  failures: ReadonlyArray<{ name?: string | null; reason?: string | null }> | null | undefined,
  sink: FailureSink,
): void {
  if (!failures || failures.length === 0) return;
  for (const f of failures) {
    sink.log(`skipped plugin '${f.name ?? '?'}': ${f.reason ?? 'unknown error'}`);
  }
  const names = failures.map((f) => f.name ?? '?').join(', ');
  sink.warn(
    `mEdit: ${failures.length} plugin(s) were skipped — their records are NOT loaded: ${names}. ` +
      `See the 'mEdit' output for details.`,
  );
}
