// A plugin skipped during session load (records Mutagen can't parse) means its
// records are missing from the session. Per ADR-0026 (integrity tier) this must
// never be silent — warn the user and log every reason. Fed from the one session
// load there is (POST /session/load-explicit, #592) and its SessionLoadResponse.failures.

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
