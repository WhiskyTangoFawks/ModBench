import { z } from 'zod';
import type { MEditClient } from '../client/MEditClient';
import { failureReason, isReadFailed } from '../wire/readFailed';
import { Refusal } from '../drivingLib/refusal';

export const SELECT_ROWS = {
  name: 'select_rows',
  description: 'The rows one SQL SELECT selects. It reads only the views, which hold every plugin the record index holds, each row saying with is_active whether its plugin is active; '
    + 'SELECT * FROM view_columns lists each view and its columns; conflict_hash(record_type, body, parse_diagnosis) hashes a copy without the values that take part in no conflict, so two copies with equal hashes are identical. A statement that is not a SELECT, reads anything else or cannot run is refused with the reason.',
  input: { sql: z.string() },
  of: async (mEdit: Pick<MEditClient, 'selectRows'>, { sql }: { sql: string }) => {
    const rows = await mEdit.selectRows(sql);
    if (isReadFailed(rows)) throw new Refusal(failureReason(rows));
    return rows;
  },
};
