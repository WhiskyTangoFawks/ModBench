import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { host, Uri } from './vscodeHost';
import { pluginsOver } from './pluginsOver';

const ARMOR_SQL = 'SELECT form_key FROM "armo"';
const APPLY = ['modbench.record.filter', '$(play) Apply as Filter'];
const CLEAR = ['modbench.record.clearFilter', '$(check) Active — click to clear'];

function lensing() {
  const made = pluginsOver();
  made.client.setQueryAnswer('setFilter', null);
  made.client.setQueryAnswer('clearFilter', null);
  made.client.setQueryAnswer('getActiveFilter', null);
  const inForce = async (sql: string) => {
    host.files.set('filter.sql', sql);
    host.picks((labels) => labels[0]);
    made.client.setQueryAnswer('getActiveFilter', { sql, source: 'filter.sql' });
    await host.run('modbench.record.filter');
  };
  const lensOn = (text: string) => host.lenses(text).map(({ command }) => [command?.command, command?.title]);
  return { ...made, inForce, lensOn };
}

describe('the code lens on a SQL document', () => {
  it('offers to apply a SQL document as the filter, naming the document', () => {
    lensing();

    expect(host.lenses(ARMOR_SQL, '/scripts/armor.sql').map(({ command }) => [command?.command, command?.title, command?.arguments])).toEqual([[...APPLY, [Uri.file('/scripts/armor.sql')]]]);
  });

  it.each([
    ['clears the filter on the document whose SQL is in force', ARMOR_SQL, ARMOR_SQL, CLEAR],
    ['offers to apply a document whose SQL differs from the filter in force', 'SELECT form_key FROM "weap"', ARMOR_SQL, APPLY],
    ['ignores leading and trailing whitespace when comparing SQL', `  ${ARMOR_SQL}  `, `\n${ARMOR_SQL}\n`, CLEAR],
  ])('%s', async (_case, inForce, text, expected) => {
    const lens = lensing();
    await lens.inForce(inForce);

    expect(lens.lensOn(text)).toEqual([expected]);
  });

  it('offers to apply again once no filter is in force', async () => {
    const lens = lensing();
    await lens.inForce(ARMOR_SQL);
    lens.client.setQueryAnswer('getActiveFilter', null);

    await host.run('modbench.record.clearFilter');

    expect(lens.lensOn(ARMOR_SQL)).toEqual([APPLY]);
  });
});
