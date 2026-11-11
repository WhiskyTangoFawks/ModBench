import type { RowsRead } from './MEditClient';
import type { ReadFailed } from '../wire/readFailed';

const STOPPED_SHORT = "mEdit's rows stopped before their last line, so they may not be every row the SELECT selects.";

async function* linesOf(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  let held = '';
  for await (const text of body.pipeThrough(new TextDecoderStream())) {
    const lines = (held + text).split('\n');
    held = lines.pop() ?? '';
    yield* lines;
  }
  if (held !== '') yield held;
}

/** The rows of `/records/select`'s stream: a JSON line per row, then a last line that ends them or says why they stopped.
 *  It stops reading once the rows' text passes `atMostChars`. */
export async function rowsOf(
  body: ReadableStream<Uint8Array>, atMostChars: number, stopped: (reason: string) => void,
): Promise<RowsRead | ReadFailed> {
  const rows: unknown[] = [];
  let chars = 0;
  for await (const line of linesOf(body)) {
    const sent: unknown = JSON.parse(line);
    if (typeof sent !== 'object' || sent === null) throw new SyntaxError(`mEdit sent a line that is not an object: ${line}`);
    if ('end' in sent) return { rows, more: false };
    if (!('row' in sent)) {
      const refusal = 'detail' in sent && typeof sent.detail === 'string' ? sent.detail : STOPPED_SHORT;
      stopped(refusal);
      return { failed: 'refused', refusal };
    }
    rows.push(sent.row);
    chars += line.length;
    if (chars > atMostChars) return { rows, more: true };
  }
  stopped(STOPPED_SHORT);
  return { failed: 'unreadable', cause: STOPPED_SHORT };
}
