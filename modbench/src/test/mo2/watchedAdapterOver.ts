import type { InstanceAdapter } from '../../instanceAdapter/instanceAdapter';
import { watchFilesInHost } from '../../hostFileWatch';
import { adapterOver, type AdapterAnswers } from './adapterOver';

/** `adapterOver`, watching through the host's watcher: for a test whose `vscode` mock carries
 *  `fakeVscodeModule()`, so each watch the adapter arms is a `FakeWatcher` it can fire. */
export function watchedAdapterOver(root: string, answers: AdapterAnswers = {}): InstanceAdapter {
  return adapterOver(root, { watchFiles: watchFilesInHost, ...answers });
}
