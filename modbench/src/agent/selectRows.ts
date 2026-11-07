import { z } from 'zod';
import type { MEditClient } from '../client/MEditClient';
import { failureReason, isReadFailed } from '../wire/readFailed';
import { Refusal } from '../drivingLib/refusal';

export const SELECT_ROWS = {
  name: 'select_rows',
  input: { sql: z.string() },
  of: async (mEdit: Pick<MEditClient, 'selectRows'>, { sql }: { sql: string }) => {
    const rows = await mEdit.selectRows(sql);
    if (isReadFailed(rows)) throw new Refusal(failureReason(rows));
    return rows;
  },
};
