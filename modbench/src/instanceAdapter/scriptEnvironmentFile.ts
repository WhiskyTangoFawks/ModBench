import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const WORKSPACE_FOLDER = '${workspaceFolder}';

export interface ScriptEnvironmentFile {
  read(): Promise<string>;
  write(text: string): Promise<void>;
}

/** The file `python.envFile` names, `.env` at the instance root when it names none. A relative name is from the instance root. */
export function scriptEnvironmentFile(instanceRoot: string, setting: () => string | undefined): ScriptEnvironmentFile {
  const path = () => {
    const named = (setting() ?? `${WORKSPACE_FOLDER}/.env`).split(WORKSPACE_FOLDER).join(instanceRoot);
    return isAbsolute(named) ? named : join(instanceRoot, named);
  };
  return {
    read: async () => {
      try {
        return await readFile(path(), 'utf8');
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return '';
        throw err;
      }
    },
    write: (text) => writeFile(path(), text),
  };
}
