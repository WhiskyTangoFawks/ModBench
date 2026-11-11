import { z } from 'zod';
import type { MEditClient } from '../client/MEditClient';
import { failureReason, isReadFailed } from '../wire/readFailed';
import { Refusal } from '../drivingLib/refusal';
import { REPLY_CHARS, tooLarge } from './tooLarge';

const FIRST_ROWS = 3;
const VALUE_CHARS = 100;

const textOf = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));

const cut = (value: unknown): unknown => {
  const text = textOf(value);
  return text.length > VALUE_CHARS ? `${text.slice(0, VALUE_CHARS)}…` : value;
};

const columnsOf = (row: unknown): [string, unknown][] => (typeof row === 'object' && row !== null ? Object.entries(row) : []);

function averageChars(rows: readonly unknown[]): Record<string, number> {
  const chars = new Map<string, number>();
  for (const [column, value] of rows.flatMap(columnsOf)) chars.set(column, (chars.get(column) ?? 0) + textOf(value).length);
  return Object.fromEntries([...chars].map(([column, total]) => [column, Math.round(total / rows.length)]));
}

export const SELECT_ROWS = {
  name: 'select_rows',
  input: { sql: z.string() },
  of: async (mEdit: Pick<MEditClient, 'selectRows'>, { sql }: { sql: string }) => {
    const read = await mEdit.selectRows(sql, REPLY_CHARS);
    if (isReadFailed(read)) throw new Refusal(failureReason(read));
    const { rows, more } = read;
    if (!more) return rows;
    throw tooLarge({
      read: rows.length, more,
      averageChars: averageChars(rows),
      first: rows.slice(0, FIRST_ROWS).map((row) => Object.fromEntries(columnsOf(row).map(([column, value]) => [column, cut(value)]))),
      script: 'A Modbench script reads every row through medit.select.',
    });
  },
};
