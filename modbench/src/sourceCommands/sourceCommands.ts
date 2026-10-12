import type { MEditClient } from '../client';

/** The source mod gestures, bound to the mEdit client. */
export function sourceCommands({ client }: { client: Pick<MEditClient, 'build'> }) {
  return {
    build: (mods: readonly string[]) => client.build(mods),
  };
}

export type SourceCommands = ReturnType<typeof sourceCommands>;
