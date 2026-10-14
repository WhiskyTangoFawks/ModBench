import { z } from 'zod';

/** `answer` is what the agent gets in place of the message, when it needs more than why. */
export class Refusal extends Error {
  constructor(message: string, readonly answer?: unknown) {
    super(message);
  }
}

export function parseOrRefuse<T>(schema: z.ZodType<T>, given: unknown): T {
  const parsed = schema.safeParse(given);
  if (!parsed.success) throw new Refusal(z.prettifyError(parsed.error));
  return parsed.data;
}
