import { describe, it, expect, vi } from 'vitest';
import { askOne, dispatchOne } from '../externalChangeGestures';
import type { ExternalChangeCoordinatorDeps } from '../externalChangeCoordinator';
import { APPLY_BUTTON, BASELINE_BUTTON } from '../externalChangeDialog';
import type { MEditClient, UnansweredExternalChange } from '../../client';
import { recordingReporter } from '../../test/surfacingDoubles';

type AnswerClient = Partial<Pick<MEditClient, 'keepAsMyEdit' | 'absorbUpstreamUpdate'>>;

// Every method the deps' own `client` field requires, so a test's own partial override still
// satisfies the full port — the untouched methods are never called for that test.
function fullClient(client: AnswerClient): Required<AnswerClient> {
  return { keepAsMyEdit: vi.fn(), absorbUpstreamUpdate: vi.fn(), ...client };
}

function unanswered(over: Partial<UnansweredExternalChange> = {}): UnansweredExternalChange {
  return {
    origin: 'ModA', plugins: ['Fixture.esp'], trackedFiles: [], metaChanged: false, oldVersion: null, newVersion: null,
    ...over,
  };
}

const first = { name: 'A.esp', origin: 'ModA' };
const second = { name: 'B.esp', origin: 'ModA' };

function makeDispatchDeps(client: AnswerClient, showDialogChoice: string | undefined) {
  return {
    client: fullClient(client),
    showDialog: vi.fn().mockResolvedValue(showDialogChoice),
    reporter: recordingReporter(),
  };
}

// One mod's question asked, then its answer done.
async function answerOne(deps: ExternalChangeCoordinatorDeps, change: UnansweredExternalChange): Promise<void> {
  await dispatchOne(deps, change.origin, await askOne(deps, change));
}

describe('asking one mod\'s question and doing its answer', () => {
  it('a landed Keep says nothing', async () => {
    const client = { keepAsMyEdit: vi.fn().mockResolvedValue({ succeeded: true, refusalReason: null }) };
    const deps = makeDispatchDeps(client, APPLY_BUTTON);

    await answerOne(deps, unanswered());

    expect(client.keepAsMyEdit).toHaveBeenCalledWith('ModA');
    expect(deps.reporter.reports).toEqual([]);
  });

  it('a WriteRefused Keep shows the ready-to-show message', async () => {
    const client = { keepAsMyEdit: vi.fn().mockResolvedValue({ refused: true, message: 'Could not keep "ModA" as your own edit — boom' }) };
    const deps = makeDispatchDeps(client, APPLY_BUTTON);

    await answerOne(deps, unanswered());

    expect(deps.reporter.reports).toEqual([{ severity: 'error', message: 'Could not keep "ModA" as your own edit — boom', detail: undefined }]);
  });

  // A collision rides a 200 as `succeeded: false` — `WriteRefused` above never sees this case.
  it('a typed Keep refusal shows its own message', async () => {
    const client = { keepAsMyEdit: vi.fn().mockResolvedValue({ succeeded: false, refusalReason: 'x' }) };
    const deps = makeDispatchDeps(client, APPLY_BUTTON);

    await answerOne(deps, unanswered());

    expect(deps.reporter.reports).toEqual([{ severity: 'error', message: 'Could not keep "ModA" as your own edit — x', detail: undefined }]);
  });

  it('a landed Absorb is silent', async () => {
    const client = { absorbUpstreamUpdate: vi.fn().mockResolvedValue({ landed: [first], refused: [], trackedFilesRefusal: null }) };
    const deps = makeDispatchDeps(client, BASELINE_BUTTON);

    await answerOne(deps, unanswered());

    expect(deps.reporter.reports).toEqual([]);
    expect(deps.reporter.reports).toEqual([]);
  });

  it('a WriteRefused Absorb shows the ready-to-show message', async () => {
    const client = {
      absorbUpstreamUpdate: vi.fn().mockResolvedValue({ refused: true, message: 'Could not absorb the upstream update for "ModA" — could not be parsed' }),
    };
    const deps = makeDispatchDeps(client, BASELINE_BUTTON);

    await answerOne(deps, unanswered());

    expect(deps.reporter.reports).toEqual([{ severity: 'error', message: 'Could not absorb the upstream update for "ModA" — could not be parsed', detail: undefined }]);
  });

  // ADR-0019: a partial save is an integrity failure, so the plugins that did not land are named
  // even though others did.
  it('a partial Absorb names each refused plugin and why', async () => {
    const client = {
      absorbUpstreamUpdate: vi.fn().mockResolvedValue({
        landed: [first], refused: [{ item: second, reason: "'Update B.esp' could not be committed to main." }], trackedFilesRefusal: null,
      }),
    };
    const deps = makeDispatchDeps(client, BASELINE_BUTTON);

    await answerOne(deps, unanswered({ plugins: ['A.esp', 'B.esp'] }));

    expect(deps.reporter.reports).toEqual([{
      severity: 'error',
      message: 'Could not absorb 1 of 2 plugins of the upstream update for "ModA".',
      detail: `"B.esp" ('Update B.esp' could not be committed to main.)`,
    }]);
  });

  it('an Absorb whose tracked-files commit failed after every plugin landed says so', async () => {
    const client = {
      absorbUpstreamUpdate: vi.fn().mockResolvedValue({
        landed: [first, second], refused: [], trackedFilesRefusal: "'Update ModA' could not be committed to main.",
      }),
    };
    const deps = makeDispatchDeps(client, BASELINE_BUTTON);

    await answerOne(deps, unanswered({ plugins: ['A.esp', 'B.esp'] }));

    expect(deps.reporter.reports).toEqual([{
      severity: 'error',
      message: 'Could not commit the rest of the upstream update for "ModA": every plugin landed.',
      detail: "'Update ModA' could not be committed to main.",
    }]);
  });

  it('an Absorb that landed nothing names every refused plugin', async () => {
    const client = {
      absorbUpstreamUpdate: vi.fn().mockResolvedValue({
        landed: [],
        refused: [
          { item: first, reason: "'Update A.esp' could not be committed to main." },
          { item: second, reason: "B.esp was not committed: 'Update A.esp' failed first and stopped the run." },
        ],
        trackedFilesRefusal: null,
      }),
    };
    const deps = makeDispatchDeps(client, BASELINE_BUTTON);

    await answerOne(deps, unanswered({ plugins: ['A.esp', 'B.esp'] }));

    expect(deps.reporter.reports.map((r) => r.message)).toEqual(['Could not absorb 2 of 2 plugins of the upstream update for "ModA".']);
  });

  it('declining the dialog (defer) calls neither verb', async () => {
    const client = { keepAsMyEdit: vi.fn(), absorbUpstreamUpdate: vi.fn() };
    const deps = makeDispatchDeps(client, undefined);

    await answerOne(deps, unanswered());

    expect(client.keepAsMyEdit).not.toHaveBeenCalled();
    expect(client.absorbUpstreamUpdate).not.toHaveBeenCalled();
  });
});
