import { runUnderProgress, type RecordWrite } from './writingGesture';
import type { Instance } from '../instanceLoader/instance';

// The read's load-order put is what the record index must reach before the rows show the write.
export function recordWriteOver(
  view: string, instance: Pick<Instance, 'refresh'>, client: { latestLoadOrder(): Promise<unknown> },
): RecordWrite {
  const untilIndexShows = {
    refresh: async (wrote?: readonly string[]) => {
      await instance.refresh(wrote);
      await client.latestLoadOrder();
    },
  };
  return (command) => runUnderProgress(view, untilIndexShows, (_progress, written) => command(written));
}
