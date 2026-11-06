import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeInputBox {
  title?: string;
  password?: boolean;
  value: string;
  busy: boolean;
  validationMessage?: string;
  hidden: boolean;
  accept: () => Promise<void>;
  hide: () => void;
  onDidAccept: (listener: () => Promise<void>) => void;
  onDidHide: (listener: () => void) => void;
  show: () => void;
  dispose: () => void;
}

const { handlers, contextKeys, boxes, registerCommand, executeCommand, createInputBox } = vi.hoisted(() => {
  const handlers = new Map<string, () => Promise<void>>();
  const contextKeys = new Map<string, unknown>();
  const boxes: FakeInputBox[] = [];
  return {
    handlers,
    contextKeys,
    boxes,
    registerCommand: vi.fn((command: string, handler: () => Promise<void>) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: vi.fn((command: string, key: string, value: unknown) => {
      if (command === 'setContext') contextKeys.set(key, value);
      return Promise.resolve();
    }),
    createInputBox: vi.fn((): FakeInputBox => {
      let accepted: () => Promise<void> = () => Promise.resolve();
      let hid: () => void = () => undefined;
      const box: FakeInputBox = {
        value: '', busy: false, hidden: false,
        accept: () => accepted(),
        hide: () => { box.hidden = true; hid(); },
        onDidAccept: (listener) => { accepted = listener; },
        onDidHide: (listener) => { hid = listener; },
        show: () => undefined,
        dispose: () => undefined,
      };
      boxes.push(box);
      return box;
    }),
  };
});

vi.mock('vscode', () => ({
  commands: { registerCommand, executeCommand },
  window: { createInputBox },
}));

import { registerNexusCommands } from '../nexusCommands';
import { LOGGED_IN_KEY, PREMIUM_KEY } from '../../test/manifest';
import { nexusLogin } from '../../instanceCommands/nexusLogin';
import { acceptingGoodKey, GOOD_KEY, json, nexusAnswering } from '../../nexus/test/nexusDouble';
import { tagRecordingReporterFor } from '../../test/surfacingDoubles';
import { AgentCall } from '../../drivingLib/agentGesture';
import { present } from '../../ports/present';
import { aWriteInFlight } from '../../test/writeInFlight';

function registered(secretsFail?: 'get' | 'delete', account?: Response) {
  const over = nexusAnswering(account === undefined ? acceptingGoodKey : () => account);
  if (secretsFail === 'get') over.secrets.get = () => Promise.reject(new Error('keyring locked'));
  if (secretsFail === 'delete') over.secrets.delete = () => Promise.reject(new Error('keyring locked'));
  const { reporter, reporterFor, tags } = tagRecordingReporterFor();
  registerNexusCommands({ commands: nexusLogin(over.nexus), nexus: over.nexus, reporterFor });
  return { ...over, reporter, tags };
}

const run = (id: string, ...args: unknown[]) => (present(handlers.get(id), `the registered handler for "${id}"`) as (...given: unknown[]) => Promise<unknown>)(...args);

function openPrompt() {
  const done = run('modbench.instance.logIn');
  return { done, box: present(boxes.at(-1), 'the input box the gesture opened') };
}

beforeEach(() => {
  handlers.clear();
  contextKeys.clear();
  boxes.length = 0;
  vi.clearAllMocks();
});

describe('Log in', () => {
  it('prompts for the key as a password', () => {
    registered();

    const { box } = openPrompt();

    expect(box.password).toBe(true);
  });

  it('asks Nexus nothing until the key is accepted, and nothing when Esc closes the prompt', async () => {
    const { sent, nexus } = registered();
    const { box, done } = openPrompt();
    box.value = 'typing';

    box.hide();
    await done;

    expect(sent).toEqual([]);
    expect(await nexus.loggedIn()).toBe(false);
  });

  it('reports under the nexus tag', () => {
    expect(registered().tags).toEqual(['nexus']);
  });

  it('keeps the prompt open on a refused key, saying why in the prompt and in the Output', async () => {
    const { reporter } = registered();
    const { box } = openPrompt();
    box.value = 'wrong';

    await box.accept();

    expect(box.hidden).toBe(false);
    expect(box.validationMessage).toBe('Nexus refused this key.');
    expect(reporter.shownFailures).toEqual([{ severity: 'error', message: 'Nexus did not take the key.', detail: 'Nexus refused this key.' }]);
    expect(reporter.reports).toEqual([]);
  });

  it('keeps nothing and says nothing when Esc closes the prompt while Nexus is checking', async () => {
    const { nexus, reporter } = registered();
    const { box, done } = openPrompt();
    box.value = GOOD_KEY;

    const accepting = box.accept();
    box.hide();
    await accepting;
    await done;

    expect(await nexus.loggedIn()).toBe(false);
    expect(reporter.shownFailures).toEqual([]);
  });

  it('validates a key accepted twice while the check is in flight once, and asks once more whether it is Premium', async () => {
    const { sent } = registered();
    const { box } = openPrompt();
    box.value = GOOD_KEY;

    await Promise.all([box.accept(), box.accept()]);

    await vi.waitFor(() => expect(contextKeys.has(PREMIUM_KEY)).toBe(true));
    expect(sent).toHaveLength(2);
  });

  it('validates the key it accepts once, closes the prompt, and marks the user logged in', async () => {
    const { sent } = registered();
    const { box, done } = openPrompt();
    box.value = GOOD_KEY;

    await box.accept();
    await done;

    await vi.waitFor(() => expect(contextKeys.get(LOGGED_IN_KEY)).toBe(true));
    await vi.waitFor(() => expect(contextKeys.has(PREMIUM_KEY)).toBe(true));
    expect(sent).toHaveLength(2);
  });
});

describe('Log in while a write is in flight', () => {
  it('tells the user once that the write was refused, keeps the prompt open, and never says Nexus refused the key', async () => {
    const { told } = aWriteInFlight();
    const { sent, reporter } = registered();
    const { box } = openPrompt();
    box.value = GOOD_KEY;

    await box.accept();

    expect({
      sent, hidden: box.hidden, validationMessage: box.validationMessage, shownOnSurface: reporter.shownFailures,
      told: told.reports.map(({ message }) => message),
    }).toEqual({
      sent: [], hidden: false, validationMessage: undefined, shownOnSurface: [],
      told: ['modbench.instance.logIn did not start: modbench.test.held is still writing.'],
    });
  });
});

describe('Premium', () => {
  it.each([[true], [false]])('marks the user as Premium when Nexus says so: %s', async (premium) => {
    const { nexus } = registered(undefined, json({ is_premium: premium }));
    await nexus.keep(GOOD_KEY);

    await vi.waitFor(() => expect(contextKeys.get(PREMIUM_KEY)).toBe(premium));
  });
});

describe('Log out', () => {
  it('forgets the key and marks the user logged out, asking nothing', async () => {
    const { nexus } = registered();
    await nexus.keep(GOOD_KEY);
    await vi.waitFor(() => expect(contextKeys.get(LOGGED_IN_KEY)).toBe(true));

    await run('modbench.instance.logOut');

    await vi.waitFor(() => expect(contextKeys.get(LOGGED_IN_KEY)).toBe(false));
    expect(boxes).toEqual([]);
  });

  it('says why in a notification when the key cannot be forgotten', async () => {
    const { reporter } = registered('delete');

    await run('modbench.instance.logOut');

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to log out of Nexus.', detail: 'keyring locked' }]);
  });
});

describe('Log out, called by an agent', () => {
  it('forgets the key and answers it landed', async () => {
    const { nexus, reporter } = registered();
    await nexus.keep(GOOD_KEY);

    expect([await run('modbench.instance.logOut', new AgentCall([], {})), await nexus.loggedIn(), reporter.reports]).toEqual([
      { applied: true, outcome: { landed: [], refused: [] } }, false, [],
    ]);
  });

  it('answers the reason when the key cannot be forgotten, and reports nothing', async () => {
    const { reporter } = registered('delete');

    expect([await run('modbench.instance.logOut', new AgentCall([], {})), reporter.reports]).toEqual([{ applied: false, refusal: 'keyring locked' }, []]);
  });
});

describe('The logged-in context key', () => {
  it('follows a key kept or forgotten elsewhere, since the secret store tells every window', async () => {
    const { secrets } = registered();
    await vi.waitFor(() => expect(contextKeys.get(LOGGED_IN_KEY)).toBe(false));

    await secrets.store('modbench.nexus.apiKey', GOOD_KEY);
    await vi.waitFor(() => expect(contextKeys.get(LOGGED_IN_KEY)).toBe(true));

    await secrets.delete('modbench.nexus.apiKey');
    await vi.waitFor(() => expect(contextKeys.get(LOGGED_IN_KEY)).toBe(false));
  });

  it('is reported, not thrown, when the secret store cannot be read', async () => {
    const { reporter } = registered('get');

    await vi.waitFor(() => expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not read whether you are logged in to Nexus.', detail: 'keyring locked' },
    ]));
  });
});
