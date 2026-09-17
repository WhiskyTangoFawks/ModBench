// A caught value's static type is `unknown`; only an `Error` proves it has `.message`. Every
// catch that needs a string for a log line or a refusal reads it through here.

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
