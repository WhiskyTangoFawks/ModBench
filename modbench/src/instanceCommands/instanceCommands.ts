import type { MEditClient } from '../client';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import type { TailOf } from '../coreLib/boundCommand';
import { refresh, type InstanceGame } from './loadOrder';
import { switchProfile } from './profile';

/** The instance-wide commands, bound to one instance: each takes the gesture's arguments only. */
export function instanceCommands(
  { adapter, client, instanceRoot }: { adapter: InstanceAdapter; client: Pick<MEditClient, 'rebuildIndex'>; instanceRoot: string },
) {
  return {
    switchProfile: (...args: TailOf<typeof switchProfile>) => switchProfile(adapter, ...args),
    refresh: (game: InstanceGame) => refresh(client, instanceRoot, game),
  };
}

export type InstanceCommands = ReturnType<typeof instanceCommands>;
