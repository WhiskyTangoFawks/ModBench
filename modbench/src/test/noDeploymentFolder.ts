import type { DeploymentFolderSetting } from '../toolbox/ToolboxProvider';

export const NO_DEPLOYMENT_FOLDER: DeploymentFolderSetting = { value: () => undefined, changed: () => ({ dispose: () => undefined }) };
