import { z } from 'zod';
import type { MEditClient } from '../client/MEditClient';
import { failureReason, isReadFailed } from '../wire/readFailed';
import { Refusal } from '../drivingLib/refusal';

export const SELECT_ROWS = {
  name: 'select_rows',
  description: 'The rows one SQL SELECT over the index selects, as the record filter selects them. '
    + 'A statement that is not a SELECT, or cannot run, is refused with the database\'s reason.',
  input: { sql: z.string() },
  of: async (mEdit: Pick<MEditClient, 'selectRows'>, { sql }: { sql: string }) => {
    const rows = await mEdit.selectRows(sql);
    if (isReadFailed(rows)) throw new Refusal(failureReason(rows));
    return rows;
  },
};
