/** A gesture or read refuses its caller with a reason. `answer` is what an agent gets in place of the message, when it needs more than why. */
export class Refusal extends Error {
  constructor(message: string, readonly answer?: unknown) {
    super(message);
  }
}
