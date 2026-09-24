/** VS Code reads `key == false` as `!key`, which an unset key also satisfies, so the instance
 *  check's answer is a string and an unset key means the check has not run. */
export const FOLDER_KEY = 'modbench.folder';

export type FolderCheck = 'instance' | 'notAnInstance';

/** Unset until the Instance's first value lands, so an empty view before the read says nothing. */
export const INSTANCE_READ_KEY = 'modbench.instanceRead';
