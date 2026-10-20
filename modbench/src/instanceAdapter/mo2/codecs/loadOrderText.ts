// MO2's loadorder.txt: each plugin once, in order, with no enabled marker, one per CRLF-ended line.

import { firstLines } from '../../../loadOrderFileCodec/firstLines';
import { parsePlugins, pluginKey } from '../../../loadOrderFileCodec/pluginsText';

export function loadOrderTextOf(pluginsText: string): string {
  return firstLines(parsePlugins(pluginsText), ({ name }) => pluginKey(name)).kept.map(({ name }) => `${name}\r\n`).join('');
}
