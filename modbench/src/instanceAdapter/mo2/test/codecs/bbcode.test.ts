import { describe, it, expect, vi } from 'vitest';
import { fakeVscodeModule } from '../../../../test/mo2/fakeVscodeWatcher';
import { mo2InstanceHolding } from '../../../test/instanceOnDisk';

vi.mock('vscode', () => fakeVscodeModule());

const NAME = 'Release.7z';

async function writtenAs(description: string): Promise<string | undefined> {
  const { adapter, text } = mo2InstanceHolding({ [`downloads/${NAME}`]: 'bytes' });
  await adapter.writeNexusFileInfo(NAME, { game: 'fallout4', modID: '1', description });
  return (await text(`downloads/${NAME}.meta`)).split('\r\n').find((line) => line.startsWith('description='))?.slice('description='.length);
}

describe('a description\'s BBCode as MO2 converts it to HTML in a downloaded file\'s .meta', () => {
  it.each([
    ['[b]x[/b]', '<b>x</b>'],
    ['[i]x[/i]', '<i>x</i>'],
    ['[u]x[/u]', '<u>x</u>'],
    ['[s]x[/s]', '<s>x</s>'],
    ['[sub]x[/sub]', '<sub>x</sub>'],
    ['[sup]x[/sup]', '<sup>x</sup>'],
    ['[size=5]x[/size]', String.raw`"<font size=\"5\">x</font>"`],
    ['[font=Arial]x[/font]', String.raw`"<font style=\"font-family: Arial;\">x</font>"`],
    ['[center]x[/center]', String.raw`"<div align=\"center\">x</div>"`],
    ['[right]x[/right]', String.raw`"<div align=\"right\">x</div>"`],
    ['[quote]x[/quote]', String.raw`"<figure class=\"quote\"><blockquote>x</blockquote></figure>"`],
    ['[quote=Someone]x[/quote]', String.raw`"<figure class=\"quote\"><blockquote>x</blockquote></figure>"`],
    ['[spoiler]x[/spoiler]', String.raw`"<details><summary>Spoiler:  <div class=\"bbc_spoiler_show\">Show</div></summary><div class=\"spoiler_content\">x</div></details>"`],
    ['[code]x[/code]', '<code>x</code>'],
    ['[heading]x[/heading]', '<h2><strong>x</strong></h2>'],
    ['a[line]b', 'a<hr>b'],
    ['[list][*]a[*]b[/list]', '<ul><li>a</li><li>b</li></ul>'],
    ['[ul][li]a[/li][/ul]', '<ul><li>a</li></ul>'],
    ['[ol][li]a[/li][/ol]', '<ol><li>a</li></ol>'],
    ['[table][tr][th]h[/th][td]d[/td][/tr][/table]', '<table><tr><th>h</th><td>d</td></tr></table>'],
    ['[url]http://a[/url]', String.raw`"<a href=\"http://a\">http://a</a>"`],
    ['[url=http://a]x[/url]', String.raw`"<a href=\"http://a\">x</a>"`],
    ['[img]http://a.png[/img]', String.raw`"<img src=\"http://a.png\">"`],
    ['[img width=10, height=20]http://a.png[/img]', String.raw`"<img src=\"http://a.png\">"`],
    ['[img=alt]http://a.png[/img]', String.raw`"<img src=\"http://a.png\" alt=\"alt\">"`],
    ['[email=a@b.c]mail[/email]', String.raw`"<a href=\"mailto:a@b.c\">mail</a>"`],
    ['[email="a@b.c"]mail[/email]', String.raw`"<a href=\"mailto:\"a@b.c\">mail</a>"`],
    ['[youtube]abc[/youtube]', String.raw`"<a href=\"https://www.youtube.com/watch?v=abc\">https://www.youtube.com/watch?v=abc</a>"`],
  ])('turns %j into %j', async (bbcode, html) => {
    expect(await writtenAs(bbcode)).toBe(html);
  });

  it.each([
    ['[color=red]x[/color]', String.raw`"<font style=\"color: #FF0000;\">x</font>"`],
    ['[color=RED]x[/color]', String.raw`"<font style=\"color: #FF0000;\">x</font>"`],
    ['[color=#123456]x[/color]', String.raw`"<font style=\"color: #123456;\">x</font>"`],
    ['[color=teal]x[/color]', String.raw`"<font style=\"color: #teal;\">x</font>"`],
  ])('writes the colour of %j as %j', async (bbcode, html) => {
    expect(await writtenAs(bbcode)).toBe(html);
  });

  it.each([
    ['tags in any case', '[B]x[/b]', '<b>x</b>'],
    ['a tag inside another', '[b][i]x[/i][/b]', '<b><i>x</i></b>'],
    ['a tag inside one of its own kind', '[b]a[b]b[/b]c[/b]', '<b>a<b>b</b>c</b>'],
    ['a tag that is never closed, closed at the end', '[b]x', '<b>x</b>'],
    ['a line break', 'a\r\nb', 'a<br/>b'],
    ['escaped quotes', 'it\\\'s \\"x\\"', String.raw`it's \"x\"`],
    ['a tag MO2 does not know, kept', '[foo]x[/foo]y', '[foo]xy'],
    ['an end tag with no start, dropped', 'a[/b]c', 'ac'],
    ['a bullet that no bullet or list end follows, kept', '[*]a', '[*]a'],
    ['text without tags', 'plain text', 'plain text'],
  ])('keeps %s', async (_name, bbcode, html) => {
    expect(await writtenAs(bbcode)).toBe(html);
  });
});
