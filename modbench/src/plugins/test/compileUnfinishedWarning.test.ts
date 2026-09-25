import { describe, it, expect } from 'vitest';
import { warnCompileUnfinished } from '../compileUnfinishedWarning';
import { InMemoryMEditClient, type NotificationEvent } from '../../client';
import { recordingReporter } from '../../test/surfacingDoubles';

function compileUnfinished(plugin: string, origin: string): NotificationEvent {
  return { kind: 'compile-unfinished', plugin, origin, keys: [], sequence: 0 };
}

describe('warnCompileUnfinished', () => {
  it('warns once, naming the plugin and saying compiling again rebuilds it', () => {
    const client = new InMemoryMEditClient();
    const reporter = recordingReporter();
    warnCompileUnfinished(reporter, client);

    client.emit(compileUnfinished('Fixture.esp', 'ModA'));

    expect(reporter.reports).toEqual([{
      severity: 'warning',
      message: 'The last compile of Fixture.esp (in ModA) did not finish, so its binary is bad',
      detail: 'compile it again to rebuild it',
    }]);
  });

  it('warns about nothing once unsubscribed', () => {
    const client = new InMemoryMEditClient();
    const reporter = recordingReporter();
    const unsubscribe = warnCompileUnfinished(reporter, client);
    unsubscribe();

    client.emit(compileUnfinished('Fixture.esp', 'ModA'));

    expect(reporter.reports).toEqual([]);
  });
});
