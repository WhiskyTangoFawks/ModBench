"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const SessionWizard_1 = require("../SessionWizard");
function makeClient(plugins) {
    return {
        GET: vitest_1.vi.fn().mockResolvedValue({ data: plugins, response: { ok: true } }),
        POST: vitest_1.vi.fn().mockResolvedValue({ response: { ok: true } }),
    };
}
const detectedPaths = {
    dataFolder: '/game/Data',
    pluginsTxt: '/config/Plugins.txt',
};
function makeDeps(overrides = {}) {
    return {
        client: makeClient([]),
        detectPaths: vitest_1.vi.fn().mockResolvedValue(detectedPaths),
        showQuickPick: vitest_1.vi.fn(),
        showInputBox: vitest_1.vi.fn(),
        showErrorMessage: vitest_1.vi.fn(),
        ...overrides,
    };
}
(0, vitest_1.describe)('SessionWizard', () => {
    (0, vitest_1.beforeEach)(() => vitest_1.vi.resetAllMocks());
    (0, vitest_1.it)('skips wizard and returns true when plugins already loaded', async () => {
        const client = makeClient([{ name: 'Fallout4.esm' }]);
        const deps = makeDeps({ client });
        const wizard = new SessionWizard_1.SessionWizard(deps);
        const result = await wizard.run();
        (0, vitest_1.expect)(result).toBe(true);
        (0, vitest_1.expect)(deps.showQuickPick).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)('runs wizard and POSTs detected paths when user accepts', async () => {
        const deps = makeDeps({
            showQuickPick: vitest_1.vi.fn().mockResolvedValue({ label: 'Use detected paths' }),
        });
        const wizard = new SessionWizard_1.SessionWizard(deps);
        const result = await wizard.run();
        (0, vitest_1.expect)(result).toBe(true);
        (0, vitest_1.expect)(deps.client.POST).toHaveBeenCalledWith('/session/load', vitest_1.expect.objectContaining({
            body: { dataFolderPath: '/game/Data', pluginsTxtPath: '/config/Plugins.txt' },
        }));
    });
    (0, vitest_1.it)('returns false when user cancels Quick Pick', async () => {
        const deps = makeDeps({
            showQuickPick: vitest_1.vi.fn().mockResolvedValue(undefined),
        });
        const wizard = new SessionWizard_1.SessionWizard(deps);
        const result = await wizard.run();
        (0, vitest_1.expect)(result).toBe(false);
        (0, vitest_1.expect)(deps.client.POST).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)('prompts for manual paths when user chooses manually', async () => {
        const deps = makeDeps({
            showQuickPick: vitest_1.vi.fn().mockResolvedValue({ label: 'Choose manually…' }),
            showInputBox: vitest_1.vi.fn()
                .mockResolvedValueOnce('/custom/Data')
                .mockResolvedValueOnce('/custom/Plugins.txt'),
        });
        const wizard = new SessionWizard_1.SessionWizard(deps);
        const result = await wizard.run();
        (0, vitest_1.expect)(result).toBe(true);
        (0, vitest_1.expect)(deps.client.POST).toHaveBeenCalledWith('/session/load', vitest_1.expect.objectContaining({
            body: { dataFolderPath: '/custom/Data', pluginsTxtPath: '/custom/Plugins.txt' },
        }));
    });
    (0, vitest_1.it)('returns false when manual path input is cancelled', async () => {
        const deps = makeDeps({
            showQuickPick: vitest_1.vi.fn().mockResolvedValue({ label: 'Choose manually…' }),
            showInputBox: vitest_1.vi.fn().mockResolvedValue(undefined),
        });
        const wizard = new SessionWizard_1.SessionWizard(deps);
        const result = await wizard.run();
        (0, vitest_1.expect)(result).toBe(false);
    });
});
//# sourceMappingURL=SessionWizard.test.js.map