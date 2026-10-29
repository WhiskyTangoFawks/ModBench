import type { DeployedPath } from '../instanceAdapter/instanceAdapter';

/** Deploy's mapping as a double: a mod's Root folder lands at the game folder's root, the rest in Data. */
export const DEPLOYED_PATH: DeployedPath = (path) => (path.startsWith('Root/') ? path.slice('Root/'.length) : `Data/${path}`);
