import { noLeadingMEdit } from '../../eslint-rules/noLeadingMEdit.mjs';
import { RuleTester } from './ruleTester';

const MESSAGE =
  'A message never begins "mEdit:". Every notification, Output line, tree row and webview text is '
  + "Modbench's own voice, and the Output channel is called Modbench. mEdit is named in a sentence "
  + 'that is about it, never as a label. Only the status bar item carries the prefix, after its icon: '
  + '"$(plug) mEdit: Running" (common.md, The status bar).';

const fails = (name: string, code: string) => ({ name, code, errors: [{ message: MESSAGE }] });

new RuleTester({ languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } }).run('no-leading-medit', noLeadingMEdit, {
  valid: [
    { name: 'the status bar item\'s text, whose prefix follows its icon', code: "setStatusText('$(plug) mEdit: Running');\nsetStatusText(`$(check) mEdit: Ready (${n} plugins)`);\n" },
    { name: 'a sentence that is about mEdit', code: "setUnreachable('mEdit is disconnected — start MEditService and reload.');\n" },
    { name: '"mEdit:" past the start of a message', code: "warn('Could not reach mEdit: the request timed out');\nwarn(`${verb} failed — mEdit: ${reason}`);\n" },
  ],
  invalid: [
    fails('a string literal that begins "mEdit:"', "warn('mEdit: Could not copy the record');\n"),
    fails('a template literal that begins "mEdit:"', 'log(`mEdit: ${reason}`);\n'),
    fails('a template literal whose head spells "mEdit:" with an escape', 'log(`\\u006dEdit: ${reason}`);\n'),
    fails('a JSX attribute that begins "mEdit:"', 'const row = <span title="mEdit: unreachable" />;\n'),
    fails('a message whose "mEdit:" follows leading whitespace', "warn('  mEdit: Could not copy the record');\n"),
    fails('a lowercase "medit:"', "warn('medit: Could not copy the record');\n"),
    fails('a prefix split off to be concatenated', "log('mEdit: ' + reason);\n"),
    fails('JSX text that begins "mEdit:"', 'const row = <span>mEdit: unreachable</span>;\n'),
  ],
});
