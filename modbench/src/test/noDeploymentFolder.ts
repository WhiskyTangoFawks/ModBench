import type { DeploymentRowSetting } from '../toolbox/ToolboxProvider';

export const NO_DEPLOYMENT_FOLDER: DeploymentRowSetting = { id: 'modbench.deployment.folder', inspect: () => undefined, nameOf: (path) => path, changed: () => ({ dispose: () => undefined }) };
