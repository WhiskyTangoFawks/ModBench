import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { host } from './vscodeHost';
import { pluginsOver } from './pluginsOver';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';

const valueOf = (...names: string[]) =>
  instanceValueFixture({ plugins: names.map((name, line) => ({ name, path: `/fixture/${name}`, origin: 'SomeMod', line, enabled: true, winning: true })) });

async function selecting(...names: string[]) {
  const instance = new FakeInstance(valueOf(...names));
  const made = pluginsOver({ instance, value: instance.value });
  const [a, b] = await made.rows();
  const rebuildFiringNoEvent = () => { Object.assign(made.view(), { selection: [] }); };
  const shows = async (...shown: string[]) => { instance.publish(valueOf(...shown)); await made.rows(); };
  return {
    ...made, a: present(a, 'the first row'), b, shows, rebuildFiringNoEvent,
    select: (rows: readonly unknown[]) => { made.view().selectRows(rows); },
    followed: () => made.shown.followed.selection,
  };
}

describe('the selection the Plugins view follows', () => {
  it('answers the view\'s selection', async () => {
    const { a, select, followed } = await selecting('A.esp');

    select([a]);

    expect(followed()).toEqual([a]);
  });

  it('answers the view\'s selection once the tree has handed its rows back', async () => {
    const { a, b, select, rebuildFiringNoEvent, followed, view } = await selecting('A.esp', 'B.esp');
    select([a]);
    rebuildFiringNoEvent();

    Object.assign(view(), { selection: [b] });

    expect(followed()).toEqual([b]);
  });

  it('answers nothing once the user has cleared the selection', async () => {
    const { a, select, followed } = await selecting('A.esp');
    select([a]);

    select([]);

    expect(followed()).toEqual([]);
  });

  it('answers nothing for a row that has gone for good', async () => {
    const { a, select, rebuildFiringNoEvent, shows, followed } = await selecting('A.esp', 'B.esp');
    select([a]);

    await shows('B.esp');
    rebuildFiringNoEvent();

    expect(followed()).toEqual([]);
  });

  it('answers nothing for a row the tree hides, even after the row is shown again', async () => {
    const { a, select, rebuildFiringNoEvent, shows, followed } = await selecting('A.esp', 'B.esp');
    select([a]);
    await shows('B.esp');
    rebuildFiringNoEvent();
    expect(followed()).toEqual([]);

    await shows('A.esp', 'B.esp');

    expect(followed()).toEqual([]);
  });

  it('answers the row the tree shows now for the one that was selected', async () => {
    const { a, select, rebuildFiringNoEvent, shows, followed, rows } = await selecting('A.esp');
    select([a]);

    await shows('A.esp');
    rebuildFiringNoEvent();

    const [rebuilt] = await rows();
    expect([followed()[0] === rebuilt, rebuilt === a]).toEqual([true, false]);
  });

  it('stops listening when disposed', async () => {
    const { a, select, followed, dispose } = await selecting('A.esp');
    dispose();

    select([a]);
    Object.assign(host.treeView(), { selection: [] });

    expect(followed()).toEqual([]);
  });
});
