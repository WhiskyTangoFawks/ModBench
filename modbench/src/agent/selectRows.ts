import { z } from 'zod';
import type { MEditClient } from '../client/MEditClient';
import { failureReason, isReadFailed } from '../wire/readFailed';
import { Refusal } from '../drivingLib/refusal';

export const SELECT_ROWS = {
  name: 'select_rows',
  description: 'The rows one SQL SELECT selects. It reads only the views, which hold every plugin the index holds, each row saying with is_active whether its plugin is active; '
    + 'SELECT * FROM view_columns lists each view and its columns. A statement that is not a SELECT, reads anything else or cannot run is refused with the reason.',
  input: { sql: z.string() },
  of: async (mEdit: Pick<MEditClient, 'selectRows'>, { sql }: { sql: string }) => {
    const rows = await mEdit.selectRows(sql);
    if (isReadFailed(rows)) throw new Refusal(failureReason(rows));
    return rows;
  },
};
