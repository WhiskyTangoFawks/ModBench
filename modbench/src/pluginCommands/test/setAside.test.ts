import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { trashSetAsideOn } from '../setAside';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { fakeInstanceAdapter } from '../../test/fakeInstanceAdapter';
import { recordingReporter } from '../../test/surfacingDoubles';

describe('trashSetAsideOn — scripts.md, Writing, story 8: a file a make replaced goes to the trash', () => {
  it('trashes each file mEdit names as set aside, where it was set aside', async () => {
    const client = new InMemoryMEditClient();
    const instance = fakeInstanceAdapter();
    const reporter = recordingReporter();
    trashSetAsideOn({ client, adapter: instance.adapter, trash: vi.fn(), reporter });

    client.setAside({ folder: '/mods/Patch', paths: ['.medit_tmp_replaced_a/Patch.esp', '.medit_tmp_replaced_b/patch.ESP'] });

    await vi.waitFor(() => expect(instance.calls).toEqual([
      { verb: 'trashFileIn', folder: '/mods/Patch', relativePath: '.medit_tmp_replaced_a/Patch.esp' },
      { verb: 'trashFileIn', folder: '/mods/Patch', relativePath: '.medit_tmp_replaced_b/patch.ESP' },
    ]));
    expect(reporter.reports).toEqual([]);
  });

  it('names a file the trash did not take, where it stays and why, and trashes the rest', async () => {
    const client = new InMemoryMEditClient();
    const refused = '.medit_tmp_replaced_a/Patch.esp';
    const instance = fakeInstanceAdapter(undefined, {
      refusals: (call) => (call.verb === 'trashFileIn' && call.relativePath === refused ? 'the trash is full' : undefined),
    });
    const reporter = recordingReporter();
    trashSetAsideOn({ client, adapter: instance.adapter, trash: vi.fn(), reporter });

    client.setAside({ folder: '/mods/Patch', paths: [refused, '.medit_tmp_replaced_b/Other.esp'] });

    await vi.waitFor(() => expect(instance.calls).toHaveLength(2));
    expect(reporter.reports).toEqual([{
      severity: 'error',
      message: `Moving Patch.esp, which a Modbench script replaced, to the trash did not finish. It was at ${join('/mods/Patch', refused)}.`,
      detail: 'the trash is full',
    }]);
  });
});
