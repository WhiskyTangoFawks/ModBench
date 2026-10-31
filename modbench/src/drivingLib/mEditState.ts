export type MEditStatus = 'starting' | 'running' | 'disconnected' | 'stopped';

const SHOWN: Record<MEditStatus, { icon: string; text: string }> = {
  starting:     { icon: 'loading~spin', text: 'mEdit: Starting…' },
  running:      { icon: 'plug', text: 'mEdit: Running' },
  disconnected: { icon: 'error', text: 'mEdit: Disconnected' },
  stopped:      { icon: 'circle-slash', text: 'mEdit: Stopped' },
};

/** common.md, The status bar, story 1: mEdit's state, and the count of active plugins once the snapshot is indexed. */
export function mEditState(status: MEditStatus, indexedActivePlugins: number | undefined): { icon: string; text: string } {
  return indexedActivePlugins === undefined ? SHOWN[status] : { icon: 'check', text: `mEdit: Ready (${indexedActivePlugins} plugins)` };
}

/** What the agent reads of mEdit's state: what the status bar and the Plugins view's message line say of it. */
export interface MEditStanding {
  messages(): readonly string[];
}
