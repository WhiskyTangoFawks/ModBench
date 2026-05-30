"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionWizard = void 0;
class SessionWizard {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async run() {
        const { data } = await this.deps.client.GET('/plugins', {});
        const plugins = data;
        if (Array.isArray(plugins) && plugins.length > 0) {
            return true;
        }
        const detected = await this.deps.detectPaths();
        const items = [
            ...(detected ? [{
                    label: 'Use detected paths',
                    detail: `${detected.dataFolder}  •  ${detected.pluginsTxt}`,
                }] : []),
            { label: 'Choose manually…' },
        ];
        const choice = await this.deps.showQuickPick(items);
        if (!choice)
            return false;
        let paths = null;
        if (choice.label === 'Use detected paths' && detected) {
            paths = detected;
        }
        else {
            const dataFolder = await this.deps.showInputBox({ prompt: 'Data folder path', value: detected?.dataFolder });
            if (!dataFolder)
                return false;
            const pluginsTxt = await this.deps.showInputBox({ prompt: 'Plugins.txt path', value: detected?.pluginsTxt });
            if (!pluginsTxt)
                return false;
            paths = { dataFolder, pluginsTxt };
        }
        const { response } = await this.deps.client.POST('/session/load', {
            body: { dataFolderPath: paths.dataFolder, pluginsTxtPath: paths.pluginsTxt },
        });
        if (!response.ok) {
            this.deps.showErrorMessage(`Failed to load session: ${response.status}`);
            return false;
        }
        return true;
    }
}
exports.SessionWizard = SessionWizard;
//# sourceMappingURL=SessionWizard.js.map