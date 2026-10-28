import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { present } from '../ports/present';

export const COMMANDS_MARKDOWN = readFileSync(path.join(__dirname, '..', '..', '..', 'spec', 'surfaces', 'commands.md'), 'utf8');

const SYSTEM_COMMANDS = COMMANDS_MARKDOWN.indexOf('## System commands');
export const GESTURES_MARKDOWN = COMMANDS_MARKDOWN.slice(0, SYSTEM_COMMANDS);
export const SYSTEM_COMMANDS_MARKDOWN = COMMANDS_MARKDOWN.slice(SYSTEM_COMMANDS);

export const SPECIFIED_AHEAD_OF_CODE: string[] = ['modbench.instance.purge'];

export const RETIRED_AHEAD_OF_CODE: string[] = [];

/** The Command IDs of the catalog's rows, or of those whose Effect is `effect`. */
export function catalogCommandIds(markdown: string, effect?: string): Set<string> {
  const ids = new Set<string>();
  let header: string[] | undefined;
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) {
      header = undefined;
      continue;
    }
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (header === undefined) {
      header = cells;
      continue;
    }
    const columns = header;
    const cellOf = (column: string): string => cells[columns.indexOf(column)] ?? '';
    if (effect !== undefined && cellOf('Effect') !== effect) continue;
    for (const match of cellOf('Command ID').matchAll(/`(modbench\.[\w.]+)`/g)) {
      ids.add(present(match[1], 'the backticked Command ID'));
    }
  }
  return ids;
}
