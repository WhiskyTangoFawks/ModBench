import { describe, it, expect, vi } from 'vitest';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { CopyChanged } from '../../wire/recordCopy';

vi.mock('vscode', () => ({ Disposable: class { constructor(public dispose: () => void) {} } }));

import { followCopiesIntoDocuments } from '../copyFollowers';

const inModA = { formKey: '000803:A.esp', plugin: { name: 'A.esp', origin: 'ModA' } };
const inModB = { formKey: '000901:B.esp', plugin: { name: 'B.esp', origin: 'ModB' } };

function following() {
  const client = new InMemoryMEditClient();
  const children: CopyChanged[] = [];
  const carrier: CopyChanged[] = [];
  followCopiesIntoDocuments(client, { changedWhere: (affects) => { children.push(affects); } }, {
    followCarried: (affects) => { carrier.push(affects); return Promise.resolve(); },
  });
  const changedIn = (asked: CopyChanged[]) => asked.flatMap((affects) => [inModA, inModB].filter(affects));
  return { client, children: () => changedIn(children), carrier: () => changedIn(carrier), asked: () => [children.length, carrier.length] };
}

describe('the copies a report changes, for the child documents and the carrier alike', () => {
  const reports: [string, (client: InMemoryMEditClient) => void, typeof inModA[]][] = [
    ['rows changed in its plugin', (c) => { c.emit({ kind: 'rows-changed', plugin: 'A.esp', origin: 'ModA', keys: ['000804:A.esp'], sequence: 1 }); }, [inModA]],
    ['rows changed in another plugin of the same name', (c) => { c.emit({ kind: 'rows-changed', plugin: 'A.esp', origin: 'ModB', keys: ['000803:A.esp'], sequence: 1 }); }, []],
  ];

  it.each(reports)('%s', (_name, report, changed) => {
    const { client, children, carrier, asked } = following();

    report(client);

    expect(asked()).toEqual([1, 1]);
    expect(children()).toEqual(changed);
    expect(carrier()).toEqual(changed);
  });
});
