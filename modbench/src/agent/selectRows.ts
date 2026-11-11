import { z } from 'zod';
import type { MEditClient } from '../client/MEditClient';
import { failureReason, isReadFailed } from '../wire/readFailed';
import { Refusal } from '../drivingLib/refusal';

// Claude Code holds 25,000 tokens of one tool's reply by default, and JSON runs about three characters a token.
const REPLY_CHARS = 75_000;

export const SELECT_ROWS = {
  name: 'select_rows',
  input: { sql: z.string() },
  of: async (mEdit: Pick<MEditClient, 'selectRows'>, { sql }: { sql: string }) => {
    const rows = await mEdit.selectRows(sql, REPLY_CHARS);
    if (isReadFailed(rows)) throw new Refusal(failureReason(rows));
    if (!Array.isArray(rows)) throw new Refusal(`The rows outgrow one reply of ${REPLY_CHARS} characters. A Modbench script reads them all through medit.select.`);
    return rows;
  },
};
