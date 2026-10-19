import type { MEditClient } from '../client';
import { runWritingGesture, type RecordWrite } from './writingGesture';
import type { Instance } from '../instanceLoader/instance';

// The read's load-order put is what the record index must reach before the rows show the write.
export function recordWriteOver(
  view: string, instance: Pick<Instance, 'refresh'>, client: Pick<MEditClient, 'latestLoadOrder'>,
): RecordWrite {
  const untilIndexShows = {
    refresh: async () => {
      await instance.refresh();
      await client.latestLoadOrder();
    },
  };
  return (command) => runWritingGesture(view, untilIndexShows, command);
}
