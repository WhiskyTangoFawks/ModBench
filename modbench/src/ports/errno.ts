// `fs`/`child_process` failures carry `code` (`ENOENT`, `EXDEV`, ...) on an otherwise ordinary
// `Error` — a shape Node names but never proves at the call site. Every catch that branches on
// it reads it through here, the one cast of that shape.

/** The `code` a caught Node `fs`/`child_process` error carries, or `undefined` when `err` isn't
 *  that shape (not an object, or `code` isn't a string). */
export function errnoCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const witness = err as { code?: unknown };
  return typeof witness.code === 'string' ? witness.code : undefined;
}
