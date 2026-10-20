// The one place the build chooses its mod manager's implementation of the Instance adapter.

import { isMo2Instance, mo2InstanceAdapter } from './mo2/mo2Instance';

/** Whether the folder is an instance of the manager the build implements. */
export const isInstance = isMo2Instance;
/** The adapter over the instance in `instanceRoot`. */
export const adapterForInstance = mo2InstanceAdapter;
