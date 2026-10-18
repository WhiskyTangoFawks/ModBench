import { describe, it, expect } from 'vitest';
import { renderedCopy } from '../renderedCopy';

const copy = { formKey: '000801:A.esp', plugin: { name: 'A.esp', origin: 'ModA' } };

describe("a rendered copy's text", () => {
  it.each([
    ['the text mEdit renders', { fileName: 'Gun.json', text: '{ "EditorID": "Gun" }' }, { text: '{ "EditorID": "Gun" }' }],
    ['a refusal naming the copy, when the plugin holds none', null, { refused: 'A.esp (ModA) holds no 000801:A.esp.' }],
    ['a refusal with the reason, when the read failed', { failed: 'refused', refusal: 'The plugin is unreadable.' }, { refused: 'The plugin is unreadable.' }],
  ] as const)('is %s', async (_case, answer, expected) => {
    expect(await renderedCopy({ getRenderedDocument: () => Promise.resolve(answer) }, copy)).toEqual(expected);
  });
});
