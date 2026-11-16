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
import { recordingReporter } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';
import type { MasterlistCommands } from '../../instanceCommands/masterlist';

const UPDATE = 'modbench.instance.updateMasterlist';
const PLUGINS_VIEW = 'modbench.plugins';

const update = vi.fn<MasterlistCommands['update']>();

function register() {
  const reporter = recordingReporter();
  const said: (string | undefined)[] = [];
  registerMasterlistCommand({
    commands: { update },
    instance: { refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(undefined); } },
    pluginsView: PLUGINS_VIEW,
    say: (message) => { said.push(message); },
    reporter,
  });
  return { reporter, said, run: (...args: unknown[]) => present(handlers.get(UPDATE), 'the registered handler')(...args) };
}

beforeEach(() => {
  handlers.clear();
  progressSteps.length = 0;
  vi.clearAllMocks();
  update.mockResolvedValue({ applied: true, written: ['masterlist.yaml', 'prelude.yaml'] });
});

describe('from the palette', () => {
  it("says so in the Plugins view's message line while it runs, and gives the line back", async () => {
    const { run, said } = register();

    await run();

    expect(said).toEqual(['Updating the masterlist…', undefined]);
    expect(progressSteps).toEqual([`progress opens on ${PLUGINS_VIEW}`, 'progress closes']);
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

  it('answers the refusal LOOT gave', async () => {
    update.mockResolvedValue({ applied: false, refusal: 'Could not reach LOOT: offline' });
    const { run } = register();

    expect(await run(new AgentCall([], {}))).toEqual({ applied: false, refusal: 'Could not reach LOOT: offline' });
  });
});
