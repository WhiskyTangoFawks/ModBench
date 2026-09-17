import { errorMessage } from './errorMessage';

/** A caught error turned into the `{ applied: false }` arm every command result shares. */
export function refuse(err: unknown): { applied: false; refusal: string } {
  return { applied: false, refusal: errorMessage(err) };
}
