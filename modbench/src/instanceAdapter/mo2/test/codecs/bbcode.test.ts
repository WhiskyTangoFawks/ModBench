import { describe, it, expect } from 'vitest';
import { convertToHtml } from '../../codecs/bbcode';

describe('a description\'s BBCode as MO2 converts it to HTML', () => {
  it.each([
    ['[b]x[/b]', '<b>x</b>'],
    ['[i]x[/i]', '<i>x</i>'],
    ['[u]x[/u]', '<u>x</u>'],
    ['[s]x[/s]', '<s>x</s>'],
    ['[sub]x[/sub]', '<sub>x</sub>'],
    ['[sup]x[/sup]', '<sup>x</sup>'],
    ['[size=5]x[/size]', '<font size="5">x</font>'],
    ['[font=Arial]x[/font]', '<font style="font-family: Arial;">x</font>'],
    ['[center]x[/center]', '<div align="center">x</div>'],
    ['[right]x[/right]', '<div align="right">x</div>'],
    ['[quote]x[/quote]', '<figure class="quote"><blockquote>x</blockquote></figure>'],
    ['[quote=Someone]x[/quote]', '<figure class="quote"><blockquote>x</blockquote></figure>'],
    ['[spoiler]x[/spoiler]', '<details><summary>Spoiler:  <div class="bbc_spoiler_show">Show</div></summary><div class="spoiler_content">x</div></details>'],
    ['[code]x[/code]', '<code>x</code>'],
    ['[heading]x[/heading]', '<h2><strong>x</strong></h2>'],
    ['a[line]b', 'a<hr>b'],
    ['[list][*]a[*]b[/list]', '<ul><li>a</li><li>b</li></ul>'],
    ['[ul][li]a[/li][/ul]', '<ul><li>a</li></ul>'],
    ['[ol][li]a[/li][/ol]', '<ol><li>a</li></ol>'],
    ['[table][tr][th]h[/th][td]d[/td][/tr][/table]', '<table><tr><th>h</th><td>d</td></tr></table>'],
    ['[url]http://a[/url]', '<a href="http://a">http://a</a>'],
    ['[url=http://a]x[/url]', '<a href="http://a">x</a>'],
    ['[img]http://a.png[/img]', '<img src="http://a.png">'],
    ['[img width=10, height=20]http://a.png[/img]', '<img src="http://a.png">'],
    ['[img=alt]http://a.png[/img]', '<img src="http://a.png" alt="alt">'],
    ['[email=a@b.c]mail[/email]', '<a href="mailto:a@b.c">mail</a>'],
    ['[email="a@b.c"]mail[/email]', '<a href="mailto:"a@b.c">mail</a>'],
    ['[youtube]abc[/youtube]', '<a href="https://www.youtube.com/watch?v=abc">https://www.youtube.com/watch?v=abc</a>'],
  ])('turns %j into %j', (bbcode, html) => {
    expect(convertToHtml(bbcode)).toBe(html);
  });

  it.each([
    ['[color=red]x[/color]', '<font style="color: #FF0000;">x</font>'],
    ['[color=RED]x[/color]', '<font style="color: #FF0000;">x</font>'],
    ['[color=#123456]x[/color]', '<font style="color: #123456;">x</font>'],
    ['[color=teal]x[/color]', '<font style="color: #teal;">x</font>'],
  ])('writes the colour of %j as %j', (bbcode, html) => {
    expect(convertToHtml(bbcode)).toBe(html);
  });

  it.each([
    ['tags in any case', '[B]x[/b]', '<b>x</b>'],
    ['a tag inside another', '[b][i]x[/i][/b]', '<b><i>x</i></b>'],
    ['a tag inside one of its own kind', '[b]a[b]b[/b]c[/b]', '<b>a<b>b</b>c</b>'],
    ['a tag that is never closed, closed at the end', '[b]x', '<b>x</b>'],
    ['a line break', 'a\r\nb', 'a<br/>b'],
    ['escaped quotes', 'it\\\'s \\"x\\"', 'it\'s "x"'],
    ['a tag MO2 does not know, kept', '[foo]x[/foo]y', '[foo]xy'],
    ['an end tag with no start, dropped', 'a[/b]c', 'ac'],
    ['a bullet that no bullet or list end follows, kept', '[*]a', '[*]a'],
    ['text without tags', 'plain text', 'plain text'],
  ])('keeps %s', (_name, bbcode, html) => {
    expect(convertToHtml(bbcode)).toBe(html);
  });
});
