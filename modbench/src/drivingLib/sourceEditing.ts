import type { PluginAddress } from '../wire/pluginAddress';
import type { OneAtATime } from './oneAtATime';
import type { WorkspaceChanges } from './applyWorkspaceChanges';

/** How a gesture reaches plugin source through VS Code's documents. */
export interface SourceEditing {
  /** The dirty documents the backend reads in place of their files. */
  unsaved: () => readonly { path: string; text: string }[];
  /** Resolves the files VS Code did not save, and rejects when it did not apply the changes. */
  applyWorkspaceChanges: (items: readonly WorkspaceChanges[]) => Promise<readonly string[]>;
  /** Runs each gesture after the ones before it settle, so none reads unsaved texts another is about to save. */
  oneAtATime: OneAtATime;
  /** The native Source Control panel misses a working-tree change on its own. */
  refreshSourceControlFor: (plugin: PluginAddress) => void;
}
