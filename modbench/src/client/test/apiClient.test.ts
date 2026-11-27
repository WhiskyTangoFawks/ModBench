import { describe, it, expect } from 'vitest';
import type { WriteRefused } from '..';
import { settled } from '../../test/eventually';
import { EMPTY_SNAPSHOT, loadOrderStatusEventFixture } from './fixtures';
import { jsonResponse, runningMEdit } from './fakeMEdit';

async function refusedHandOver(respond: () => Response): Promise<WriteRefused | undefined> {
  const { client } = await runningMEdit({ routes: [['/unsaved-document', () => Promise.resolve(respond())]] });
  const told = new Promise<WriteRefused | undefined>((resolve) => { client.onUnsavedHandOver(resolve); });
  client.handUnsavedDocument({ path: '/m/plugin-source/A.esp/Npc.json', text: '{}', version: 1 });
  return told;
}

describe('errorText, the sentence written for the user rather than the RFC 7807 ProblemDetails envelope the backend answers every failure in', () => {
  it.each([
    ['a string body, passed through', () => jsonResponse(400, 'bad dir'), 'bad dir'],
    ['no body, as empty', () => new Response(null, { status: 400 }), ''],
    ['a null body, as empty', () => jsonResponse(400, null), ''],
    ['a problem, by its detail', () => jsonResponse(423, { type: 'about:blank', title: 'Locked', status: 423, detail: 'held elsewhere' }), 'held elsewhere'],
    ['a problem with no detail, by its title', () => jsonResponse(423, { title: 'Locked', status: 423 }), 'Locked'],
    ['an object that is not a problem, as JSON', () => jsonResponse(400, { form_key: '000801:Fallout4.esm' }), '{"form_key":"000801:Fallout4.esm"}'],
  ])('writes %s', async (_, respond, text) => {
    await expect(refusedHandOver(respond)).resolves.toEqual({ refused: true, message: `mEdit could not take the unsaved plugin source — ${text}` });
  });
});

describe('isTerminalLoadOrderStatusFor', () => {
  it('is not terminal while the record index validates a change, though its conflicts are computed', async () => {
    const mEdit = await runningMEdit({ routes: [['/load-order', () => Promise.resolve(jsonResponse(200, { applied: true, version: 2 }))]] });
    let outcome: unknown;
    void mEdit.client.sendLoadOrder(EMPTY_SNAPSHOT).then((sent) => { outcome = sent; });
    await settled(() => { expect(mEdit.fetch.mock.calls.some(([request]) => request.method === 'PUT')).toBe(true); });

    await mEdit.fire(loadOrderStatusEventFixture({ conflictsComputed: true, validating: true, version: 2 }));
    expect(outcome).toBeUndefined();
    await mEdit.fire(loadOrderStatusEventFixture({ conflictsComputed: true, validating: false, version: 2 }));

    await settled(() => { expect(outcome).toEqual({ outcome: 'applied', version: 2 }); });
  });
});

describe('toLoadOrderStatus', () => {
  it('keeps each indexed plugin as (origin, filename), so two of one filename stay two, and carries conflictsComputed false through a Ready wire state, as the whole-set conflict sweep leaves a Ready load order with stale winners', async () => {
    const { client, fire } = await runningMEdit();

    await fire(loadOrderStatusEventFixture({
      state: 'Ready', totalPlugins: 3,
      indexedPlugins: [{ name: 'Shared.esp', origin: 'ModA' }, { name: 'Shared.esp', origin: 'ModB' }],
      conflictsComputed: false,
      failures: [{ name: 'Bad.esp', origin: 'SomeMod', reason: 'RACE parse' }],
    }));

    expect(client.recordIndexProgress).toEqual({ done: 3, total: 3, version: 1, settled: false });
  });

  it.each([
    ['None', undefined],
    ['Reconciling', { done: 0, total: 0, version: 1, settled: false }],
  ] as const)('says whether the record index holds none for the %s state, as a rebuild drops the record index before it refills and no other field tells it from a reconcile that has indexed nothing yet', async (state, progress) => {
    const { client, fire } = await runningMEdit();

    await fire(loadOrderStatusEventFixture({ state, conflictsComputed: false }));

    expect(client.recordIndexProgress).toEqual(progress);
  });

  it.each([
    ['HeldElsewhere', 'This instance\'s index is open in another Modbench window.',
      { kind: 'heldElsewhere', message: 'This instance\'s index is open in another Modbench window.' }],
    ['Failed', 'the reconcile threw something unexpected', { kind: 'failed', message: 'the reconcile threw something unexpected' }],
    ['HeldElsewhere', null, undefined],
  ] as const)('carries the %s state with the message %j as the refusal %j', async (state, message, refusal) => {
    const { client, fire } = await runningMEdit();

    await fire(loadOrderStatusEventFixture({ state, message, conflictsComputed: false }));

    expect(client.recordIndexProgress?.refusal).toEqual(refusal);
  });
});
