import type { DeploymentFolderSetting } from '../toolbox/ToolboxProvider';

export const NO_DEPLOYMENT_FOLDER: DeploymentFolderSetting = { inspect: () => undefined, nameOf: (path) => path, changed: () => ({ dispose: () => undefined }) };
