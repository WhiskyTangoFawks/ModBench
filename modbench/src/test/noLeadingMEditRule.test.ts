import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import { noLeadingMEdit } from '../../eslint-rules/noLeadingMEdit.mjs';

const MESSAGE =
  'A message never begins "mEdit:". Every notification, Output line, tree row and webview text is '
  + "Modbench's own voice, and the Output channel is called Modbench. mEdit is named in a sentence "
  + 'that is about it, never as a label. Only the status bar item carries the prefix, after its icon: '
  + '"$(plug) mEdit: Attached" (common.md, The status bar).';

function lint(code: string): Linter.LintMessage[] {
  const linter = new Linter();
  return linter.verify(code, {
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { local: { rules: { x: noLeadingMEdit } } },
    rules: { 'local/x': 'error' },
  });
}

describe('no-leading-medit', () => {
  it('fails a planted string literal that begins "mEdit:", with the rule\'s own message', () => {
    const messages = lint("warn('mEdit: Could not copy the record');\n");

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toBe(MESSAGE);
  });

  it('fails a template literal that begins "mEdit:"', () => {
    const messages = lint('log(`mEdit: ${reason}`);\n');

    expect(messages).toHaveLength(1);
  });

  it('fails a template literal whose head spells "mEdit:" with an escape', () => {
    const messages = lint('log(`\\u006dEdit: ${reason}`);\n');

    expect(messages).toHaveLength(1);
  });

  it('fails a JSX attribute that begins "mEdit:"', () => {
    const messages = lint('const row = <span title="mEdit: unreachable" />;\n');

    expect(messages).toHaveLength(1);
  });

  it('fails a message whose "mEdit:" follows leading whitespace', () => {
    const messages = lint("warn('  mEdit: Could not copy the record');\n");

    expect(messages).toHaveLength(1);
  });

  it('fails a lowercase "medit:"', () => {
    const messages = lint("warn('medit: Could not copy the record');\n");

    expect(messages).toHaveLength(1);
  });

  it('fails a prefix split off to be concatenated', () => {
    const messages = lint("log('mEdit: ' + reason);\n");

    expect(messages).toHaveLength(1);
  });

  it('fails JSX text that begins "mEdit:"', () => {
    const messages = lint('const row = <span>mEdit: unreachable</span>;\n');

    expect(messages).toHaveLength(1);
  });

  it('passes the status bar item\'s text, whose prefix follows its icon', () => {
    const messages = lint("setStatusText('$(plug) mEdit: Attached');\nsetStatusText(`$(check) mEdit: Ready (${n} plugin copies)`);\n");

    expect(messages).toEqual([]);
  });

  it('passes a sentence that is about mEdit', () => {
    const messages = lint("setUnreachable('mEdit is disconnected — start MEditService and reload.');\n");

    expect(messages).toEqual([]);
  });

  it('passes "mEdit:" past the start of a message', () => {
    const messages = lint("warn('Could not reach mEdit: the request timed out');\nwarn(`${verb} failed — mEdit: ${reason}`);\n");

    expect(messages).toEqual([]);
  });
});
