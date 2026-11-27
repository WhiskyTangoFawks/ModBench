import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { host } from './vscodeHost';
import { symbolsOver } from './symbolsOver';
import { spelledName } from './mEditNames';
import { cancellableToken } from '../../client/test/fixtures';
import { localFailure } from '../../wire/readFailed';

const FILE = '/instance/source/Mod/plugin-source/Mod.esp/Npc.json';
const TEXT = '{ "FormKey": "000801:Mod.esp", "Script": "Gu" }';
const AT_SCRIPT = `${TEXT.slice(0, TEXT.indexOf('Gu') + 1)}|${TEXT.slice(TEXT.indexOf('Gu') + 1)}`;
const asked = (made: ReturnType<typeof symbolsOver>) => made.client.calls.filter(({ method }) => method === 'getPluginSourceNames').map(({ args }) => args);

describe('the names at a place in plugin source, as mEdit answers them (target-architecture.md)', () => {
  it('answers each kind the name of that kind at a place, asking with its file and the token of the request it answers', async () => {
    const made = symbolsOver({ arrange: (client) => { client.setQueryAnswer('getPluginSourceNames', [spelledName('Script', TEXT, 'Gu')]); } });
    const { token } = cancellableToken();

    const hover = await host.hover(FILE, AT_SCRIPT, token);

    expect(hover).toEqual({ text: 'Gu', spans: 'Gu' });
    expect(asked(made)).toEqual(asked(made).map(() => [TEXT, FILE, TEXT.indexOf('Gu') + 1, token]));
  });

  it('names nothing where mEdit cannot answer, and the Output says why once, however many kinds ask of the place', async () => {
    const made = symbolsOver({ arrange: (client) => { client.setQueryFailure('getPluginSourceNames', localFailure('mEdit is down')); } });

    const hover = await host.hover(FILE, AT_SCRIPT);

    expect([hover, asked(made).length > 1, made.reporter.shownFailures]).toEqual([
      undefined, true, [{ severity: 'error', message: 'Cannot tell what plugin source names here.', detail: 'mEdit is down' }],
    ]);
  });
});
