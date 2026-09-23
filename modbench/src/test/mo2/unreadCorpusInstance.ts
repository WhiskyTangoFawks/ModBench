import { rm } from 'node:fs/promises';
import { Instance } from '../../instanceLoader/instance';
import { cloneCorpusFixture } from './corpusFixture';

/** A real Instance over a corpus clone that has not read yet, so a test orders a view's render
 *  against the first read. The caller's `vscode` mock carries `fakeVscodeModule()`. */
export async function withUnreadCorpusInstance(test: (instance: Instance, root: string) => Promise<void>): Promise<void> {
  const root = await cloneCorpusFixture();
  const instance = new Instance({
    instanceRoot: root, log: () => {}, logReadFailure: () => {},
    resolveGameDirectory: () => Promise.resolve(undefined),
  });
  try {
    await test(instance, root);
  } finally {
    instance.dispose();
    await rm(root, { recursive: true, force: true });
  }
}
