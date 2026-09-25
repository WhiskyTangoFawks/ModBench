import type { MEditClient } from '../client';
import type { Reporter } from '../ports/reporter';

/** compile-plugin, Failure: a compile that did not finish left a bad binary, and compiling again
 *  is the recovery, so the warning asks nothing. Returns the unsubscribe. */
export function warnCompileUnfinished(
  reporter: Pick<Reporter, 'report'>, notifications: Pick<MEditClient, 'subscribe'>,
): () => void {
  return notifications.subscribe('compile-unfinished', (event) => {
    reporter.report(
      'warning',
      `The last compile of ${event.plugin} (in ${event.origin}) did not finish, so its binary is bad`,
      'compile it again to rebuild it',
    );
  });
}
