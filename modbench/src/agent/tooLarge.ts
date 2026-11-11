import { z } from 'zod';
import { Refusal } from '../drivingLib/refusal';

// Claude Code holds 25,000 tokens of one tool's reply by default. JSON of paths and names runs near 2.5 characters a
// token, and the standing lines ride beside the reply.
export const REPLY_CHARS = 50_000;

const TOO_LARGE = `The reply passes the ${REPLY_CHARS} characters that one reply holds.`;

/** What an agent gets in place of a reply too large to be useful: that it is, and what corrects the request. */
export const tooLarge = (correction: Record<string, unknown>): Refusal => new Refusal(TOO_LARGE, { tooLarge: TOO_LARGE, ...correction });

/** The reply, or, past `REPLY_CHARS`, a refusal that gives `correction` of it in its place. */
export function fitting<Reply>(reply: Reply, correction: (reply: Reply) => Record<string, unknown>): Reply {
  if (JSON.stringify(reply).length > REPLY_CHARS) throw tooLarge(correction(reply));
  return reply;
}

export const FILTER = { filter: z.string().optional() };

/** Whether a name holds the filter, in any case, as a view's name filter matches. */
export const holding = (filter: string | undefined) => (name: string): boolean =>
  filter === undefined || name.toLowerCase().includes(filter.toLowerCase());

/** The correction of a list that the filter narrows: how many it holds, and which of them filter keeps. */
export const filterNarrows = (count: Record<string, number>, keeps: string): Record<string, unknown> =>
  ({ ...count, narrow: `filter keeps ${keeps}, in any case.` });
