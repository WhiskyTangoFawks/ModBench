import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionWizard, type WizardDeps } from '../SessionWizard';
import type { GamePaths } from '../GamePathDetector';

function makeClient(plugins: unknown[]) {
  return {
    GET: vi.fn().mockResolvedValue({ data: plugins, response: { ok: true } }),
    POST: vi.fn().mockResolvedValue({ response: { ok: true } }),
  } as any;
}

const detectedPaths: GamePaths = {
  dataFolder: '/game/Data',
  pluginsTxt: '/config/Plugins.txt',
};

function makeDeps(overrides: Partial<WizardDeps> = {}): WizardDeps {
  return {
    client: makeClient([]),
    detectPaths: vi.fn().mockResolvedValue(detectedPaths),
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    showErrorMessage: vi.fn(),
    ...overrides,
  };
}

describe('SessionWizard', () => {
  beforeEach(() => vi.resetAllMocks());

  it('skips wizard and returns true when plugins already loaded', async () => {
    const client = makeClient([{ name: 'Fallout4.esm' }]);
    const deps = makeDeps({ client });

    const wizard = new SessionWizard(deps);
    const result = await wizard.run();

    expect(result).toBe(true);
    expect(deps.showQuickPick).not.toHaveBeenCalled();
  });

  it('runs wizard and POSTs detected paths when user accepts', async () => {
    const deps = makeDeps({
      showQuickPick: vi.fn().mockResolvedValue({ label: 'Use detected paths' }),
    });

    const wizard = new SessionWizard(deps);
    const result = await wizard.run();

    expect(result).toBe(true);
    expect(deps.client.POST).toHaveBeenCalledWith(
      '/session/load',
      expect.objectContaining({
        body: { dataFolderPath: '/game/Data', pluginsTxtPath: '/config/Plugins.txt' },
      })
    );
  });

  it('returns false when user cancels Quick Pick', async () => {
    const deps = makeDeps({
      showQuickPick: vi.fn().mockResolvedValue(undefined),
    });

    const wizard = new SessionWizard(deps);
    const result = await wizard.run();

    expect(result).toBe(false);
    expect(deps.client.POST).not.toHaveBeenCalled();
  });

  it('prompts for manual paths when user chooses manually', async () => {
    const deps = makeDeps({
      showQuickPick: vi.fn().mockResolvedValue({ label: 'Choose manually…' }),
      showInputBox: vi.fn()
        .mockResolvedValueOnce('/custom/Data')
        .mockResolvedValueOnce('/custom/Plugins.txt'),
    });

    const wizard = new SessionWizard(deps);
    const result = await wizard.run();

    expect(result).toBe(true);
    expect(deps.client.POST).toHaveBeenCalledWith(
      '/session/load',
      expect.objectContaining({
        body: { dataFolderPath: '/custom/Data', pluginsTxtPath: '/custom/Plugins.txt' },
      })
    );
  });

  it('returns false when manual path input is cancelled', async () => {
    const deps = makeDeps({
      showQuickPick: vi.fn().mockResolvedValue({ label: 'Choose manually…' }),
      showInputBox: vi.fn().mockResolvedValue(undefined),
    });

    const wizard = new SessionWizard(deps);
    const result = await wizard.run();

    expect(result).toBe(false);
  });
});
