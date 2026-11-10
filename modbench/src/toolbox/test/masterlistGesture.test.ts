import { describe, it, expect, vi, beforeEach } from 'vitest';

const { handlers, registerCommand } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
  };
});

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return { commands: { registerCommand }, window: { withProgress: recordedWithProgress } };
});

import { AgentCall } from '../../drivingLib/agentGesture';
import { progressSteps } from '../../test/recordedProgress';
import { registerMasterlistCommand } from '../masterlistGesture';
import { recordingReporter, scriptedDialog, type ScriptedDialog } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';
import type { MasterlistCommands } from '../../instanceCommands/masterlist';

const UPDATE = 'modbench.instance.updateMasterlist';
const PLUGINS_VIEW = 'modbench.plugins';

const update = vi.fn<MasterlistCommands['update']>();
const uncommitted = vi.fn<MasterlistCommands['uncommitted']>();

function register(ask: ScriptedDialog = scriptedDialog()) {
  const reporter = recordingReporter();
  const said: (string | undefined)[] = [];
  registerMasterlistCommand({
    commands: { update, uncommitted },
    instance: { refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(undefined); } },
    pluginsView: PLUGINS_VIEW,
    say: (message) => { said.push(message); },
    ask,
    reporter,
  });
  return { reporter, said, ask, run: (...args: unknown[]) => present(handlers.get(UPDATE), 'the registered handler')(...args) };
}

beforeEach(() => {
  handlers.clear();
  progressSteps.length = 0;
  vi.clearAllMocks();
  update.mockResolvedValue({ applied: true, written: ['masterlist.yaml', 'prelude.yaml'] });
  uncommitted.mockResolvedValue({ applied: true, files: [] });
});

describe('from the palette', () => {
  it("asks nothing, says so in the Plugins view's message line while it runs, and gives the line back", async () => {
    const { run, said, ask } = register();

    await run();

    expect(ask.asked).toEqual([]);
    expect(said).toEqual(['Updating the masterlist…', undefined]);
    expect(progressSteps).toEqual([`progress opens on ${PLUGINS_VIEW}`, 'Instance loader: read every file again', 'progress closes']);
  });

  it('asks once, naming the files, while git holds uncommitted changes of them, and updates on the confirming button', async () => {
    uncommitted.mockResolvedValue({ applied: true, files: ['masterlist.yaml', 'prelude.yaml'] });
    const { run, ask } = register(scriptedDialog('Update masterlist'));

    await run();

    expect(ask.asked).toEqual([{
      message: 'Update the masterlist? It replaces uncommitted changes to masterlist.yaml, prelude.yaml.', detail: undefined, buttons: ['Update masterlist'],
    }]);
    expect(update).toHaveBeenCalledOnce();
  });

  it('updates nothing when the confirmation is cancelled, and says nothing in the message line', async () => {
    uncommitted.mockResolvedValue({ applied: true, files: ['masterlist.yaml'] });
    const { run, said } = register(scriptedDialog(undefined));

    await run();

    expect(update).not.toHaveBeenCalled();
    expect(said).toEqual([]);
  });

  it('closes the view\'s progress while the confirmation waits for the person, and opens it again after', async () => {
    uncommitted.mockResolvedValue({ applied: true, files: ['masterlist.yaml'] });
    let whileAsking: string[] = [];
    const ask: ScriptedDialog = Object.assign(async () => {
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      whileAsking = [...progressSteps];
      return 'Update masterlist';
    }, { asked: [] });
    const { run } = register(ask);

    await run();

    expect(whileAsking).toEqual([`progress opens on ${PLUGINS_VIEW}`, 'progress closes']);
    expect(progressSteps.filter((step) => step.startsWith('progress opens'))).toHaveLength(2);
  });

  it('reports a git failure as an error, updating nothing', async () => {
    uncommitted.mockResolvedValue({ applied: false, refusal: 'git: not found' });
    const { run, reporter } = register();

    await run();

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not update the masterlist.', detail: 'git: not found' }]);
    expect(update).not.toHaveBeenCalled();
  });

  it('reports the refusal as an error', async () => {
    update.mockResolvedValue({ applied: false, refusal: 'LOOT did not serve the masterlist: 404' });
    const { run, reporter } = register();

    await run();

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not update the masterlist.', detail: 'LOOT did not serve the masterlist: 404' }]);
  });
});

describe('from an agent', () => {
  it('answers that it applied and names the files it wrote, with no lists of items', async () => {
    const { run } = register();

    expect(await run(new AgentCall([], {}))).toEqual({ applied: true, done: 'Wrote masterlist.yaml and prelude.yaml.' });
  });

  it('answers that the masterlist was already current when it wrote nothing', async () => {
    update.mockResolvedValue({ applied: true, written: [] });
    const { run } = register();

    expect(await run(new AgentCall([], {}))).toEqual({ applied: true, done: 'The masterlist was already current.' });
  });

  it('refuses over uncommitted changes, naming what it would lose and force, and updates nothing', async () => {
    uncommitted.mockResolvedValue({ applied: true, files: ['masterlist.yaml'] });
    const { run, ask } = register();

    expect(await run(new AgentCall([], {}))).toEqual({
      applied: false,
      refusal: 'The masterlist has uncommitted changes to masterlist.yaml, which updating would replace. Request it again with force to update it.',
    });
    expect(update).not.toHaveBeenCalled();
    expect(ask.asked).toEqual([]);
  });

  it('updates over uncommitted changes when forced, asking nothing', async () => {
    uncommitted.mockResolvedValue({ applied: true, files: ['masterlist.yaml'] });
    const { run, ask } = register();

    expect(await run(new AgentCall([], { force: true }))).toMatchObject({ applied: true });
    expect(update).toHaveBeenCalledOnce();
    expect(ask.asked).toEqual([]);
  });

  it('answers a git failure as a refusal, updating nothing', async () => {
    uncommitted.mockResolvedValue({ applied: false, refusal: 'git: not found' });
    const { run } = register();

    expect(await run(new AgentCall([], { force: true }))).toEqual({ applied: false, refusal: 'git: not found' });
    expect(update).not.toHaveBeenCalled();
  });

  it('answers the refusal LOOT gave', async () => {
    update.mockResolvedValue({ applied: false, refusal: 'Could not reach LOOT: offline' });
    const { run } = register();

    expect(await run(new AgentCall([], {}))).toEqual({ applied: false, refusal: 'Could not reach LOOT: offline' });
  });
});
