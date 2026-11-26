import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { onTestFinished } from 'vitest';
import type { InstanceAdapter } from '../instanceAdapter';
import { adapterOver, type AdapterAnswers } from '../../test/mo2/adapterOver';

const SETTINGS = '[General]\r\ngameName=Fallout 4\r\nselected_profile=@ByteArray(Default)\r\n';

export interface HeldInstance {
  readonly root: string;
  readonly adapter: InstanceAdapter;
  /** The text of the file at `path` below the instance root. */
  readonly text: (path: string) => Promise<string>;
}

/** An MO2 instance of one profile, Default, listing one mod, and holding `files` by their paths below its root, for the length of one test.
 *  A mod order that lists nothing is read again after a wait, as one caught mid-write. */
export function mo2InstanceHolding(files: Readonly<Record<string, string>> = {}, answers: AdapterAnswers = {}): HeldInstance {
  const root = mkdtempSync(join(tmpdir(), 'modbench-codec-'));
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }); });
  mkdirSync(join(root, 'mods'));
  for (const [path, text] of Object.entries({ 'ModOrganizer.ini': SETTINGS, 'profiles/Default/modlist.txt': '+Base\r\n', 'profiles/Default/plugins.txt': '', ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return { root, adapter: adapterOver(root, answers), text: (path) => readFile(join(root, path), 'utf8') };
}
