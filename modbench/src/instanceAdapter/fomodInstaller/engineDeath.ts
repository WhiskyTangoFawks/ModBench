const FATAL_HEADER = /^.*FATAL ERROR.*$/m;

export const deathWhy = (stderr: string, code: number | null, signal: NodeJS.Signals | null): string =>
  FATAL_HEADER.exec(stderr)?.[0].trim() ?? (signal === null ? `it stopped with code ${code}` : `it was killed by ${signal}`);
