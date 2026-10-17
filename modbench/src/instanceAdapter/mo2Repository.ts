// What MO2's implementation lets the instance repository hold.

import { exists, remove, write } from './files';
import type { InstanceAdapter } from './instanceAdapter';
import { ignoreListFile, WHITELIST_IGNORE_LIST } from './layout';
import type { Mo2Context } from './mo2Context';

type Mo2Repository = Pick<InstanceAdapter, 'writeIgnoreList' | 'removeIgnoreList'>;

export function mo2Repository({ instanceRoot }: Mo2Context): Mo2Repository {
  return {
    async writeIgnoreList() {
      const file = ignoreListFile(instanceRoot);
      if (await exists(file)) throw new Error(`${file} already exists; git init does not write over it.`);
      await write(file, WHITELIST_IGNORE_LIST);
    },

    removeIgnoreList: () => remove(ignoreListFile(instanceRoot)),
  };
}
