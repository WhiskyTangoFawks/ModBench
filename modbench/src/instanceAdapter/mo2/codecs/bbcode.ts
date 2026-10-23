// MO2's BBCode::convertToHTML (src/bbcode.cpp): the HTML MO2 keeps as a downloaded file's description. Each
// tag's pattern is lazy and dot-matches-all, as MO2 sets them.

interface Tag {
  readonly pattern: RegExp;
  /** `$1`, `$2` name the pattern's groups; absent for the colour tag, which MO2 builds itself. */
  readonly html?: string;
}

const tag = (source: string, html?: string): Tag => ({ pattern: new RegExp(source, 'gis'), html });

const TAGS: Readonly<Record<string, Tag>> = {
  b: tag('\\[b\\](.*?)\\[/b\\]', '<b>$1</b>'),
  i: tag('\\[i\\](.*?)\\[/i\\]', '<i>$1</i>'),
  u: tag('\\[u\\](.*?)\\[/u\\]', '<u>$1</u>'),
  s: tag('\\[s\\](.*?)\\[/s\\]', '<s>$1</s>'),
  sub: tag('\\[sub\\](.*?)\\[/sub\\]', '<sub>$1</sub>'),
  sup: tag('\\[sup\\](.*?)\\[/sup\\]', '<sup>$1</sup>'),
  'size=': tag('\\[size=([^\\]]*?)\\](.*?)\\[/size\\]', '<font size="$1">$2</font>'),
  'color=': tag('\\[color=([^\\]]*?)\\](.*?)\\[/color\\]'),
  'font=': tag('\\[font=([^\\]]*?)\\](.*?)\\[/font\\]', '<font style="font-family: $1;">$2</font>'),
  center: tag('\\[center\\](.*?)\\[/center\\]', '<div align="center">$1</div>'),
  right: tag('\\[right\\](.*?)\\[/right\\]', '<div align="right">$1</div>'),
  quote: tag('\\[quote\\](.*?)\\[/quote\\]', '<figure class="quote"><blockquote>$1</blockquote></figure>'),
  'quote=': tag('\\[quote=([^\\]]*?)\\](.*?)\\[/quote\\]', '<figure class="quote"><blockquote>$2</blockquote></figure>'),
  spoiler: tag(
    '\\[spoiler\\](.*?)\\[/spoiler\\]',
    '<details><summary>Spoiler:  <div class="bbc_spoiler_show">Show</div></summary><div class="spoiler_content">$1</div></details>',
  ),
  code: tag('\\[code\\](.*?)\\[/code\\]', '<code>$1</code>'),
  heading: tag('\\[heading\\](.*?)\\[/heading\\]', '<h2><strong>$1</strong></h2>'),
  line: tag('\\[line\\]', '<hr>'),
  list: tag('\\[list\\](.*?)\\[/list\\]', '<ul>$1</ul>'),
  'list=': tag('\\[list.*?\\](.*?)\\[/list\\]', '<ol>$1</ol>'),
  ul: tag('\\[ul\\](.*?)\\[/ul\\]', '<ul>$1</ul>'),
  ol: tag('\\[ol\\](.*?)\\[/ol\\]', '<ol>$1</ol>'),
  li: tag('\\[li\\](.*?)\\[/li\\]', '<li>$1</li>'),
  table: tag('\\[table\\](.*?)\\[/table\\]', '<table>$1</table>'),
  tr: tag('\\[tr\\](.*?)\\[/tr\\]', '<tr>$1</tr>'),
  th: tag('\\[th\\](.*?)\\[/th\\]', '<th>$1</th>'),
  td: tag('\\[td\\](.*?)\\[/td\\]', '<td>$1</td>'),
  url: tag('\\[url\\](.*?)\\[/url\\]', '<a href="$1">$1</a>'),
  'url=': tag('\\[url=([^\\]]*?)\\](.*?)\\[/url\\]', '<a href="$1">$2</a>'),
  img: tag('\\[img(?:\\s*?width=\\d+?\\s*?,??\\s*?height=\\d+?)??\\](.*?)\\[/img\\]', '<img src="$1">'),
  'img=': tag('\\[img=([^\\]]*?)\\](.*?)\\[/img\\]', '<img src="$2" alt="$1">'),
  'email=': tag('\\[email="??([^\\]]*?)"??\\](.*?)\\[/email\\]', '<a href="mailto:$1">$2</a>'),
  youtube: tag(
    '\\[youtube\\](.*?)\\[/youtube\\]',
    '<a href="https://www.youtube.com/watch?v=$1">https://www.youtube.com/watch?v=$1</a>',
  ),
  // this tag is in fact greedy
  '*': { pattern: /\[\*\](.*)/gis, html: '<li>$1</li>' },
};

const COLORS: Readonly<Record<string, string>> = {
  red: 'FF0000', green: '00FF00', blue: '0000FF', black: '000000', gray: '7F7F7F', white: 'FFFFFF', yellow: 'FFFF00', cyan: '00FFFF',
  magenta: 'FF00FF', brown: 'A52A2A', orange: 'FFA500', gold: 'FFD700', deepskyblue: '00BFFF', salmon: 'FA8072', dodgerblue: '1E90FF',
  greenyellow: 'ADFF2F', peru: 'CD853F',
};

const TAG_NAME = /[a-zA-Z*]*=?/y;
const NEXT_BULLET = /(\[\*\]|<\/ul>)/gi;

function indexOfFold(text: string, needle: string, from: number): number {
  return text.toLowerCase().indexOf(needle.toLowerCase(), from);
}

function startOfNextTag(input: string, tagName: string, from: number): number {
  const nextTag = new RegExp(`\\[${tagName}[=\\]]?`, 'gi');
  nextTag.lastIndex = from;
  return nextTag.exec(input)?.index ?? -1;
}

// Where a tag's block ends and how much of it is the closing tag; the input gains a closing tag MO2 adds when it is missing.
function blockEnd(input: string, tagName: string): { input: string; closePos: number; closeLength: number } {
  if (tagName === '*') {
    NEXT_BULLET.lastIndex = 3;
    return { input, closePos: NEXT_BULLET.exec(input)?.index ?? -1, closeLength: 0 };
  }
  if (tagName === 'line') return { input, closePos: 6, closeLength: 0 };
  const closeTag = `[/${tagName}]`;
  let closePos = indexOfFold(input, closeTag, 0);
  let nextPos = startOfNextTag(input, tagName, input.indexOf(']'));
  while (nextPos !== -1 && closePos !== -1 && nextPos < closePos) {
    closePos = indexOfFold(input, closeTag, closePos + closeTag.length);
    nextPos = startOfNextTag(input, tagName, input.indexOf(']', nextPos));
  }
  if (closePos !== -1) return { input, closePos, closeLength: closeTag.length };
  const closed = input + closeTag;
  return { input: closed, closePos: closed.length - closeTag.length, closeLength: closeTag.length };
}

function colored(block: string, { pattern }: Tag): string {
  return block.replace(pattern, (_whole, color: string, content: string) =>
    `<font style="color: ${color.startsWith('#') ? color : `#${COLORS[color.toLowerCase()] ?? color}`};">${content}</font>`);
}

// The HTML for the tag `input` opens and how many characters it took; none when it is not a tag MO2 knows.
function convertTag(input: string): { html: string; length: number } {
  const unknown = { html: '', length: 0 };
  TAG_NAME.lastIndex = 1;
  const named = (TAG_NAME.exec(input)?.[0] ?? '').toLowerCase();
  const entry = TAGS[named];
  if (entry === undefined) return unknown;
  const tagName = named.endsWith('=') ? named.slice(0, -1) : named;
  const { input: closed, closePos, closeLength } = blockEnd(input, tagName);
  if (closePos <= -1) return unknown;
  const length = closePos + closeLength;
  let block = closed.slice(0, length);
  entry.pattern.lastIndex = 0;
  if (!entry.pattern.test(block)) return unknown;
  entry.pattern.lastIndex = 0;
  if (entry.html === undefined) return tagName === 'color' ? { html: colored(block, entry), length } : unknown;
  if (tagName === '*') block = block.replace(/(\[\/\*\])?(<br\/>)?$/i, '');
  return { html: block.replace(entry.pattern, entry.html), length };
}

export function convertToHtml(text: string): string {
  const input = text.replaceAll('\r\n', '<br/>').replaceAll('\\"', '"').replaceAll("\\'", "'");
  let result = '';
  let lastBlock = 0;
  let pos = input.indexOf('[', lastBlock);
  while (pos !== -1) {
    result += input.slice(lastBlock, pos);
    if (pos < input.length - 1 && input[pos + 1] === '/') {
      const tagEnd = input.indexOf(']', pos) + 1;
      pos = tagEnd === 0 ? pos + 1 : tagEnd;
    } else {
      const { html, length } = convertTag(input.slice(pos));
      if (length === 0) {
        result += '[';
        pos += 1;
      } else {
        result += convertToHtml(html);
        pos += length;
      }
    }
    lastBlock = pos;
    pos = input.indexOf('[', lastBlock);
  }
  return result + input.slice(lastBlock);
}
