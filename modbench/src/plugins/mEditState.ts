import type { RecordIndexProgress } from '../client';

export type MEditStatus = 'starting' | 'running' | 'disconnected' | 'stopped';

const SHOWN: Record<MEditStatus, { icon: string; state: string }> = {
  starting:     { icon: 'loading~spin', state: 'Starting…' },
  running:      { icon: 'plug', state: 'Running' },
  disconnected: { icon: 'error', state: 'Disconnected' },
  stopped:      { icon: 'circle-slash', state: 'Stopped' },
};

// common.md, The status bar, story 1.
export function mEditState(status: MEditStatus, filling: RecordIndexProgress | undefined, indexedActivePlugins: number | undefined): { icon: string; state: string } {
  if (filling !== undefined) return { icon: 'sync~spin', state: `Indexing (${filling.done} of ${filling.total} plugins)` };
  return indexedActivePlugins === undefined ? SHOWN[status] : { icon: 'check', state: `Ready (${indexedActivePlugins} plugins)` };
}
