import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, registerCommand, executeCommand, collections, actionProviders } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: vi.fn(),
    actionProviders: [] as { provideCodeActions(...args: never[]): unknown }[],
    collections: [] as { clear(): void; [Symbol.iterator](): IterableIterator<[{ fsPath: string }, readonly { message: string }[]]> }[],
  };
});

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  const { taskModule } = await import('../../test/taskDouble');
  const { Diagnostic, Range, DiagnosticSeverity, FakeDiagnosticCollection, uriParse, Uri } = await import('../../test/vscodeMock');
  class CodeAction { diagnostics: unknown[] = []; command: unknown; constructor(readonly title: string, readonly kind: string) {} }
  return {
    ...taskModule(), Diagnostic, Range, DiagnosticSeverity, Uri: { ...Uri, parse: uriParse }, CodeAction, CodeActionKind: { QuickFix: 'quickfix' },
    commands: { registerCommand, executeCommand }, window: { withProgress: recordedWithProgress },
    languages: {
      registerCodeActionsProvider: (_selector: unknown, provider: { provideCodeActions(...args: never[]): unknown }) => { actionProviders.push(provider); return { dispose: () => undefined }; },
      createDiagnosticCollection: () => { const collection = new FakeDiagnosticCollection(); collections.push(collection); return collection; },
    },
  };
});

import { progressSteps } from '../../test/recordedProgress';
import { AgentCall } from '../../drivingLib/agentGesture';
import { registerDeployCommands } from '../deployGesture';
import { recordingReporter } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';
import type { InstanceSubscriber } from '../../instanceLoader/instance';
import type { DeployCommands, DeployResult, MoveToOverwriteResult, PurgeResult } from '../../instanceCommands/deploy';

const value = instanceValueFixture();
const UNCHANGED = { kind: 'unchanged', renamed: [] } as const;
const NOTHING_DEPLOYED = { applied: true, wrote: false, leftOut: [], unmanaged: [], lost: [], leftAside: [], pluginsTxt: UNCHANGED } as const;

const subscribers: InstanceSubscriber[] = [];

const inDeployed = (path: string) => ({ path, file: `/deployed/${path}` });

const NOT_MOVED: MoveToOverwriteResult = { applied: true, wrote: false, left: [] };

const NOT_PURGED: PurgeResult = { applied: true, wrote: false, restored: undefined, leftRenamed: [], unmanaged: [], unfinished: [] };

function deployAnswering(
  result: DeployResult,
  { sequence = 1, moved = NOT_MOVED, purged = NOT_PURGED, unmanagedNow = [] }: { sequence?: number; moved?: MoveToOverwriteResult; purged?: PurgeResult; unmanagedNow?: readonly string[] } = {},
) {
  const reporter = recordingReporter();
  const deploy = vi.fn<DeployCommands['deploy']>(() => { progressSteps.push('deploy'); return Promise.resolve(result); });
  const moveToOverwrite = vi.fn<DeployCommands['moveToOverwrite']>(() => { progressSteps.push('move'); return Promise.resolve(moved); });
  const purge = vi.fn<DeployCommands['purge']>(() => { progressSteps.push('purge'); return Promise.resolve(purged); });
  const unmanaged = vi.fn<DeployCommands['unmanaged']>(() => Promise.resolve({ applied: true, folder: '/deployed', unmanaged: unmanagedNow.map(inDeployed) }));
  registerDeployCommands({
    commands: { deploy, purge, moveToOverwrite, unmanaged },
    instance: { subscribe: (subscriber) => { subscribers.push(subscriber); return { dispose: () => undefined }; }, landed: () => Promise.resolve(value), sequence, refresh: () => { progressSteps.push('read again'); return Promise.resolve(undefined); } },
    reporterFor: () => reporter,
  });
  return { reporter, deploy, purge, moveToOverwrite, unmanaged, commands: { deploy }, runPurge: present(handlers.get('modbench.instance.purge'), 'the purge handler'), run: present(handlers.get('modbench.instance.deploy'), 'the deploy handler'), runMove: present(handlers.get('modbench.instance.moveToOverwrite'), 'the move handler') };
}

beforeEach(() => {
  handlers.clear();
  collections.length = 0;
  subscribers.length = 0;
  actionProviders.length = 0;
  executeCommand.mockClear();
  progressSteps.length = 0;
});

describe('Deploy', () => {
  it('deploys the files the instance value says the game gets, under the Toolbox\'s progress, and says nothing', async () => {
    const { reporter, deploy, run } = deployAnswering({ applied: true, wrote: true, leftOut: [], unmanaged: [], lost: [], leftAside: [], pluginsTxt: UNCHANGED });

    await run();

    expect([deploy.mock.calls, progressSteps, reporter.reports, reporter.landings]).toEqual([
      [[{ files: value.files, plugins: value.plugins, gameName: value.gameName }]], ['progress opens on modbench.toolbox', 'deploy', 'read again', 'progress closes'], [], [],
    ]);
  });

  it('answers its result, and reports it as the view\'s own call', async () => {
    const result = { ...NOTHING_DEPLOYED, leftOut: [{ path: 'Data/a.esp', winner: '/m/A/a.esp' }] };
    const { reporter, run } = deployAnswering(result);

    expect([await run(), reporter.reports.length]).toEqual([result, 1]);
  });

  it('answers its result to an agent call and reports nothing, as the caller reports it', async () => {
    const result = { ...NOTHING_DEPLOYED, unmanaged: ['Data/a.ini'], lost: [{ path: 'Data/x.ini', winner: '/m/B/x.ini' }] };
    const { reporter, run } = deployAnswering(result);

    expect([await run(new AgentCall([], {})), reporter.reports, reporter.shownFailures]).toEqual([result, [], []]);
  });

  it('answers a refusal to an agent call, and reports nothing', async () => {
    const { reporter, run } = deployAnswering({ applied: false, refusal: 'No deployment folder: set modbench.deployment.folder.' });

    expect([await run(new AgentCall([], {})), reporter.reports]).toEqual([{ applied: false, refusal: 'No deployment folder: set modbench.deployment.folder.' }, []]);
  });

  it('deploys no load order while the instance has not been read', async () => {
    const { deploy, run } = deployAnswering({ applied: false, refusal: 'The instance has not been read.' }, { sequence: 0 });

    await run();

    expect(deploy.mock.calls).toEqual([[undefined]]);
  });

  it('reports a refused deploy at error, saying why', async () => {
    const { reporter, run } = deployAnswering({ applied: false, refusal: 'No deployment folder: set modbench.deployment.folder.' });

    await run();

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not deploy.', detail: 'No deployment folder: set modbench.deployment.folder.' }]);
  });

  it('warns of each file it left out, naming it and the path that holds a file deploy did not write', async () => {
    const { reporter, run } = deployAnswering({ applied: true, wrote: true, leftOut: [{ path: 'Data/MCM/settings.ini', winner: '/instance/mods/A/MCM/settings.ini' }, { path: 'Data/a.esp', winner: '/instance/mods/B/a.esp' }], unmanaged: [], lost: [], leftAside: [], pluginsTxt: UNCHANGED });

    await run();

    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Deploy left out each file whose path holds a file it did not write:', detail: '/instance/mods/A/MCM/settings.ini at Data/MCM/settings.ini, /instance/mods/B/a.esp at Data/a.esp',
    }]);
  });

  it('warns of each file it left out for another the game gets at its path, naming both', async () => {
    const { reporter, run } = deployAnswering({
      applied: true, wrote: true, leftOut: [], unmanaged: [], lost: [{ path: 'Data/x.ini', winner: '/instance/mods/Lower/Root/Data/x.ini' }], leftAside: [], pluginsTxt: UNCHANGED,
    });

    await run();

    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Deploy left out each file whose path another file the game gets wins:', detail: '/instance/mods/Lower/Root/Data/x.ini at Data/x.ini',
    }]);
  });

  it('warns of each file it set aside and could not remove, which the next deploy removes', async () => {
    const { reporter, run } = deployAnswering({
      applied: true, wrote: true, leftOut: [], unmanaged: [], lost: [], leftAside: ['Data/b.esp.modbench_aside_7_0 (EBUSY: resource busy or locked)'], pluginsTxt: UNCHANGED,
    });

    await run();

    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Deploy landed, and could not remove each file it set aside, which the next deploy removes:',
      detail: 'Data/b.esp.modbench_aside_7_0 (EBUSY: resource busy or locked)',
    }]);
  });

  it('warns that it wrote no plugins.txt, saying why', async () => {
    const { reporter, run } = deployAnswering({
      applied: true, wrote: true, leftOut: [], unmanaged: [], lost: [], leftAside: [], pluginsTxt: { kind: 'notWritten', why: 'no prefix' },
    });

    await run();

    expect(reporter.reports).toEqual([{ severity: 'warning', message: 'Deploy wrote no plugins.txt:', detail: 'no prefix' }]);
  });

  it('warns of the plugins.txt it renamed, naming its new name', async () => {
    const { reporter, run } = deployAnswering({
      applied: true, wrote: true, leftOut: [], unmanaged: [], lost: [], leftAside: [], pluginsTxt: { kind: 'written', renamed: ['C:\\Local\\Fallout4\\plugins.txt.modbench_renamed', 'C:\\Local\\Fallout4\\plugins.txt.modbench_renamed_2'] },
    });

    await run();

    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Deploy renamed each plugins.txt it did not write, so the game reads the plugin order of this load order:',
      detail: 'C:\\Local\\Fallout4\\plugins.txt.modbench_renamed, C:\\Local\\Fallout4\\plugins.txt.modbench_renamed_2',
    }]);
  });

  it('raises no notification for the files it does not manage, which the Problems panel holds', async () => {
    const { reporter, run } = deployAnswering({ ...NOTHING_DEPLOYED, unmanaged: ['game.exe'] }, { unmanagedNow: ['game.exe'] });

    await run();

    expect([reporter.reports, reporter.shownFailures]).toEqual([[], []]);
  });
});

describe('the problems on the files the deployment folder holds that deploy does not manage', () => {
  const held = () => [...present(collections[0], 'the collection')].map(([uri, [problem]]) => [uri.fsPath, problem?.message]);

  it('are one on each file after a deploy, naming the file it left out at a path', async () => {
    const { run } = deployAnswering(
      { ...NOTHING_DEPLOYED, leftOut: [{ path: 'Data/a.esp', winner: '/m/A/a.esp' }], unmanaged: ['Data/a.esp', 'game.exe'] },
      { unmanagedNow: ['Data/a.esp', 'game.exe'] },
    );

    await run();

    expect(held()).toEqual([
      ['/deployed/Data/a.esp', 'Deploy does not manage this file, and left out /m/A/a.esp, which the game would get at its path.'],
      ['/deployed/game.exe', 'Deploy does not manage this file.'],
    ]);
  });

  it('are kept for an agent\'s deploy as for the user\'s', async () => {
    const { run } = deployAnswering({ ...NOTHING_DEPLOYED, unmanaged: ['game.exe'] }, { unmanagedNow: ['game.exe'] });

    await run(new AgentCall([], {}));

    expect(held()).toEqual([['/deployed/game.exe', 'Deploy does not manage this file.']]);
  });

  it('are read again after a move to Overwrite, so a file it moved has none', async () => {
    const { run, runMove, unmanaged } = deployAnswering(NOTHING_DEPLOYED, { unmanagedNow: ['a.ini', 'b.ini'] });
    await run();
    unmanaged.mockResolvedValueOnce({ applied: true, folder: '/deployed', unmanaged: [inDeployed('b.ini')] });

    await runMove(['a.ini']);

    expect(held()).toEqual([['/deployed/b.ini', 'Deploy does not manage this file.']]);
  });

  it('are read again when the instance is read again, so a file the user deleted has none', async () => {
    const { run, unmanaged } = deployAnswering(NOTHING_DEPLOYED, { unmanagedNow: ['a.ini', 'b.ini'] });
    await run();
    unmanaged.mockResolvedValueOnce({ applied: true, folder: '/deployed', unmanaged: [inDeployed('b.ini')] });

    present(subscribers[0], 'the instance subscriber')(value, 2);

    await vi.waitFor(() => { expect(held()).toEqual([['/deployed/b.ini', 'Deploy does not manage this file.']]); });
  });

  it('name no file left out by an earlier deploy once a deploy fails', async () => {
    const { run, commands } = deployAnswering(
      { ...NOTHING_DEPLOYED, leftOut: [{ path: 'a.ini', winner: '/m/A/a.ini' }] }, { unmanagedNow: ['a.ini'] },
    );
    await run();
    commands.deploy.mockResolvedValueOnce({ applied: false, refusal: 'The instance has not been read.' });

    await run();

    expect(held()).toEqual([['/deployed/a.ini', 'Deploy does not manage this file.']]);
  });

  it('are offered move to Overwrite as a quick fix, by a provider registered once', () => {
    deployAnswering(NOTHING_DEPLOYED);

    expect(actionProviders.length).toBe(1);
  });

  it('are read again after a purge', async () => {
    const { runPurge } = deployAnswering(NOTHING_DEPLOYED, { unmanagedNow: ['game.exe'] });

    await runPurge();

    expect(held()).toEqual([['/deployed/game.exe', 'Deploy does not manage this file.']]);
  });
});

describe('Purge and Move to Overwrite, called by an agent', () => {
  const none = new AgentCall([], {});

  it('answers a purge that landed with each file it left, warning at the Output and not at the user', async () => {
    const { reporter, runPurge } = deployAnswering(NOTHING_DEPLOYED, { purged: { ...NOT_PURGED, unmanaged: ['game.exe'], leftRenamed: ['plugins.txt.r'], unfinished: ['x (EBUSY)'] } });

    expect([await runPurge(none), reporter.reports, reporter.shownFailures]).toEqual([{
      applied: true, outcome: { landed: [], refused: [] }, partial: [
        { message: 'The deployment folder holds files purge did not remove:', detail: 'game.exe', severity: 'warning' },
        { message: 'Purge left each plugins.txt deploy renamed, which is yours to put back:', detail: 'plugins.txt.r', severity: 'warning' },
        { message: 'Purge landed, and could not finish:', detail: 'x (EBUSY)', severity: 'warning' },
      ],
    }, [], []]);
  });

  it('answers a refused purge with its reason', async () => {
    const { reporter, runPurge } = deployAnswering(NOTHING_DEPLOYED, { purged: { applied: false, refusal: 'No deployment folder.' } });

    expect([await runPurge(none), reporter.reports]).toEqual([{ applied: false, refusal: 'No deployment folder.' }, []]);
  });

  it('moves the files it names, or every one it does not manage when it names none', async () => {
    const { moveToOverwrite, runMove } = deployAnswering(NOTHING_DEPLOYED);

    await runMove(new AgentCall([{ kind: 'deployedFile', path: 'Data/a.esp' }], {}));
    await runMove(none);

    expect(moveToOverwrite.mock.calls).toEqual([[['Data/a.esp']], [undefined]]);
  });

  it('answers each file it left, and a refusal with its reason, reporting neither', async () => {
    const left = deployAnswering(NOTHING_DEPLOYED, { moved: { applied: true, wrote: true, left: ['Data/.hidden'] } });
    expect([await left.runMove(none), left.reporter.reports]).toEqual([{
      applied: true, outcome: { landed: [], refused: [] },
      partial: [{ message: 'Left in the deployment folder, because no mod file lands at their path:', detail: 'Data/.hidden', severity: 'warning' }],
    }, []]);

    const refused = deployAnswering(NOTHING_DEPLOYED, { moved: { applied: false, refusal: 'In the game folder.' } });
    expect([await refused.runMove(none), refused.reporter.reports]).toEqual([{ applied: false, refusal: 'In the game folder.' }, []]);
  });
});

describe('Move to Overwrite', () => {

  it('moves the files it is given under the Toolbox\'s progress, and says nothing', async () => {
    const { reporter, moveToOverwrite, runMove } = deployAnswering(NOTHING_DEPLOYED, { moved: { applied: true, wrote: true, left: [] } });

    await runMove(['Data/a.esp']);

    expect([moveToOverwrite.mock.calls, progressSteps, reporter.reports]).toEqual([
      [[['Data/a.esp']]], ['progress opens on modbench.toolbox', 'move', 'read again', 'progress closes'], [],
    ]);
  });

  it('reports a refusal at error, saying why', async () => {
    const { reporter, runMove } = deployAnswering(NOTHING_DEPLOYED, { moved: { applied: false, refusal: '"a.esp" is already in Overwrite.' } });

    await runMove(['Data/a.esp']);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not move to Overwrite.', detail: '"a.esp" is already in Overwrite.' }]);
  });

  it('warns of each file it left in the deployment folder', async () => {
    const { reporter, runMove } = deployAnswering(NOTHING_DEPLOYED, { moved: { applied: true, wrote: true, left: ['Data/.hidden'] } });

    await runMove(['Data/.hidden', 'Data/a.esp']);

    expect(reporter.reports).toEqual([{ severity: 'warning', message: 'Left in the deployment folder, because no mod file lands at their path:', detail: 'Data/.hidden' }]);
  });

  it('asks for the files deploy does not manage now when none are named, as from the command palette', async () => {
    const { moveToOverwrite, runMove } = deployAnswering(NOTHING_DEPLOYED);

    await runMove();

    expect(moveToOverwrite.mock.calls).toEqual([[undefined]]);
  });
});

describe('Purge', () => {
  it('purges under the Toolbox\'s progress, reads again, and says nothing', async () => {
    const { reporter, purge, runPurge } = deployAnswering(NOTHING_DEPLOYED, { purged: { applied: true, wrote: true, restored: '/local/plugins.txt', leftRenamed: [], unmanaged: [], unfinished: [] } });

    await runPurge();

    expect([purge.mock.calls, progressSteps, reporter.reports]).toEqual([[[]], ['progress opens on modbench.toolbox', 'purge', 'read again', 'progress closes'], []]);
  });

  it('reports a refused purge at error, saying why', async () => {
    const { reporter, runPurge } = deployAnswering(NOTHING_DEPLOYED, { purged: { applied: false, refusal: 'No deployment folder: set modbench.deployment.folder.' } });

    await runPurge();

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not purge.', detail: 'No deployment folder: set modbench.deployment.folder.' }]);
  });

  it('warns of each plugins.txt deploy renamed that it left, naming it', async () => {
    const { reporter, runPurge } = deployAnswering(NOTHING_DEPLOYED, { purged: { applied: true, wrote: true, restored: undefined, leftRenamed: ['/local/plugins.txt.modbench_renamed'], unmanaged: [], unfinished: [] } });

    await runPurge();

    expect(reporter.reports).toEqual([{ severity: 'warning', message: 'Purge left each plugins.txt deploy renamed, which is yours to put back:', detail: '/local/plugins.txt.modbench_renamed' }]);
  });

  it('warns of each thing it landed without finishing', async () => {
    const { reporter, runPurge } = deployAnswering(NOTHING_DEPLOYED, { purged: { applied: true, wrote: true, restored: undefined, leftRenamed: [], unmanaged: [], unfinished: ['Data/a.esp (EBUSY)'] } });

    await runPurge();

    expect(reporter.reports).toEqual([{ severity: 'warning', message: 'Purge landed, and could not finish:', detail: 'Data/a.esp (EBUSY)' }]);
  });
});

describe('Purge, when files remain', () => {
  it('names each file it left in the Output, and warns of how many', async () => {
    const { reporter, runPurge } = deployAnswering(NOTHING_DEPLOYED, { purged: { applied: true, wrote: true, restored: undefined, leftRenamed: [], unmanaged: ['Data/a.ini', 'game.exe'], unfinished: [] } });

    await runPurge();

    expect([reporter.shownFailures, reporter.reports]).toEqual([
      [{ severity: 'warning', message: 'The deployment folder holds files purge did not remove:', detail: 'Data/a.ini, game.exe' }],
      [{ severity: 'warning', message: 'The deployment folder holds 2 files purge did not remove, each named in the Output.', detail: undefined }],
    ]);
  });
});
