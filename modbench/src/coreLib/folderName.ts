const NOT_A_FOLDER_NAME = 'A name cannot be . or .. or contain / or \\';

/** Why a name cannot name one entry of a folder, whoever names it: a mod, a separator, a plugin. */
export const folderNameRefusal = (name: string): string | undefined =>
  name === '.' || name === '..' || /[\\/]/.test(name) ? NOT_A_FOLDER_NAME : undefined;
