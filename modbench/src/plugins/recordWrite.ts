import type { MEditClient } from '../client';
import { runWritingGesture } from '../drivingLib/writingGesture';
import type { Instance } from '../instanceLoader/instance';
import { PLUGINS_KEY_ARGS } from './gestureEntry';

/** Runs a record create, copy or delete as the Plugins view's writing gesture. */
export type RecordWrite = (command: () => Promise<void>) => Promise<void>;

// The read's load-order put is what the index must reach before the rows show the write.
export function recordWriteOver(
  instance: Pick<Instance, 'refresh'>, client: Pick<MEditClient, 'latestLoadOrderPut'>,
): RecordWrite {
  const untilIndexShows = {
    refresh: async () => {
      await instance.refresh();
      await client.latestLoadOrderPut();
    },
  };
  return (command) => runWritingGesture(PLUGINS_KEY_ARGS.view, untilIndexShows, command);
}
