import { z } from 'zod';
import { Refusal } from '../drivingLib/refusal';

export function parseOrRefuse<T>(schema: z.ZodType<T>, given: unknown): T {
  const parsed = schema.safeParse(given);
  if (!parsed.success) throw new Refusal(z.prettifyError(parsed.error));
  return parsed.data;
}
