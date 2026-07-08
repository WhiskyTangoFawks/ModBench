// A plugin skipped during session load (records Mutagen can't parse) means its
// records are missing from the session. Per ADR-0026 (integrity tier) this must
// never be silent — warn the user and log every reason. Shared by the wizard
// (POST /session/load) and the load-explicit path (POST /session/load-explicit),
// which return the identical SessionLoadResponse.failures shape.

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
