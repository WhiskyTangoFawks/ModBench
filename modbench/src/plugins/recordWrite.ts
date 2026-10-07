import type { MEditClient } from '../client';
import { runWritingGesture, type RecordWrite } from '../drivingLib/writingGesture';
import type { Instance } from '../instanceLoader/instance';
import { PLUGINS_KEY_ARGS } from './gestureEntry';

// The read's load-order put is what the index must reach before the rows show the write.
export function recordWriteOver(
  instance: Pick<Instance, 'refresh'>, client: Pick<MEditClient, 'latestLoadOrder'>,
): RecordWrite {
  const untilIndexShows = {
    refresh: async () => {
      await instance.refresh();
      await client.latestLoadOrder();
    },
  };
  return (command, invokedFrom = PLUGINS_KEY_ARGS.view) => runWritingGesture(invokedFrom, untilIndexShows, command);
}
