import { errorMessage } from '../ports/errorMessage';
import { Refusal } from '../drivingLib/refusal';

/** What a name prompt shows: the command's refusal, or why it could not tell. */
export const promptRefusal = (refusal: Promise<string | undefined>): Promise<string | undefined> =>
  refusal.catch((err: unknown) => errorMessage(err));

/** An agent call's name is refused with the command's refusal, or with why the command could not tell. */
export async function refuseAgentName(refusal: Promise<string | undefined>): Promise<void> {
  let reason: string | undefined;
  try {
    reason = await refusal;
  } catch (err) {
    throw new Refusal(errorMessage(err));
  }
  if (reason !== undefined) throw new Refusal(reason);
}
