import type { DeploymentFolderSetting } from '../toolbox/ToolboxProvider';

export const NO_DEPLOYMENT_FOLDER: DeploymentFolderSetting = { id: 'modbench.deployment.folder', inspect: () => undefined, nameOf: (path) => path, changed: () => ({ dispose: () => undefined }) };
