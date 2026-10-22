import { refuse } from '../coreLib/refuse';
import type { CommandResult } from '../coreLib/commandResult';
import type { Nexus } from '../nexus/nexus';

async function logIn(nexus: Nexus, typed: string, signal: AbortSignal): Promise<CommandResult> {
  const key = typed.trim();
  try {
    const checked = await nexus.check(key);
    if (!checked.valid) return { applied: false, refusal: checked.reason };
    if (signal.aborted) return { applied: false, refusal: 'Cancelled.' };
    await nexus.keep(key);
    return { applied: true, wrote: true };
  } catch (err) {
    return refuse(err);
  }
}

async function logOut(nexus: Nexus): Promise<CommandResult> {
  try {
    await nexus.forget();
    return { applied: true, wrote: true };
  } catch (err) {
    return refuse(err);
  }
}

export function nexusLogin(nexus: Nexus) {
  return {
    logIn: (key: string, signal: AbortSignal) => logIn(nexus, key, signal),
    logOut: () => logOut(nexus),
  };
}

export type NexusLogin = ReturnType<typeof nexusLogin>;
