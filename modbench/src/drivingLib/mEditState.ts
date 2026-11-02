export type MEditStatus = 'starting' | 'running' | 'disconnected' | 'stopped';

const SHOWN: Record<MEditStatus, { icon: string; state: string }> = {
  starting:     { icon: 'loading~spin', state: 'Starting…' },
  running:      { icon: 'plug', state: 'Running' },
  disconnected: { icon: 'error', state: 'Disconnected' },
  stopped:      { icon: 'circle-slash', state: 'Stopped' },
};

/** common.md, The status bar, story 1: mEdit's state, and the count of active plugins once the snapshot is indexed. */
export function mEditState(status: MEditStatus, indexedActivePlugins: number | undefined): { icon: string; state: string } {
  return indexedActivePlugins === undefined ? SHOWN[status] : { icon: 'check', state: `Ready (${indexedActivePlugins} plugins)` };
}
