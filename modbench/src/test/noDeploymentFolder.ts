import type { DeploymentFolderSetting } from '../toolbox/ToolboxProvider';

export const NO_DEPLOYMENT_FOLDER: DeploymentFolderSetting = { value: () => ({ path: '', name: '' }), changed: () => ({ dispose: () => undefined }) };
