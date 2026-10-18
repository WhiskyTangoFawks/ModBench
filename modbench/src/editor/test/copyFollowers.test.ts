import { describe, it, expect, vi } from 'vitest';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { CopyChanged } from '../recordCopy';

vi.mock('vscode', () => ({ Disposable: class { constructor(public dispose: () => void) {} } }));

import { followChangedCopies } from '../copyFollowers';

const inModA = { formKey: '000803:A.esp', plugin: { name: 'A.esp', origin: 'ModA' } };
const inModB = { formKey: '000901:B.esp', plugin: { name: 'B.esp', origin: 'ModB' } };

function following() {
  const client = new InMemoryMEditClient();
  const asked: CopyChanged[] = [];
  followChangedCopies(client, { changedWhere: (affects) => { asked.push(affects); } }, {
    followCarried: (affects) => { asked.push(affects); return Promise.resolve(); },
  });
  const changedCopies = () => [...new Set(asked.flatMap((affects) => [inModA, inModB].filter(affects)))];
  return { client, asked, changedCopies };
}

describe('the copies a report changes, for the child documents and the carrier alike', () => {
  const reports: [string, (client: InMemoryMEditClient) => void, typeof inModA[]][] = [
    ['rows changed in its plugin', (c) => { c.emit({ kind: 'rows-changed', plugin: 'A.esp', origin: 'ModA', keys: ['000804:A.esp'], sequence: 1 }); }, [inModA]],
    ['rows changed in another plugin of the same name', (c) => { c.emit({ kind: 'rows-changed', plugin: 'A.esp', origin: 'ModB', keys: ['000803:A.esp'], sequence: 1 }); }, []],
    ['its plugin read again whole', (c) => { c.emit({ kind: 'plugin-changed', plugin: 'A.esp', origin: 'ModA', keys: [], sequence: 1 }); }, [inModA]],
    ['the stream of reports opening again', (c) => { c.reconnected(); }, [inModA, inModB]],
  ];

  it.each(reports)('%s', (_name, report, changed) => {
    const { client, asked, changedCopies } = following();

    report(client);

    expect(asked).toHaveLength(2);
    expect(changedCopies()).toEqual(changed);
  });
});
