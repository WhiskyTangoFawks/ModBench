import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fomodLanding, type ConditionFacts, type FomodEngine } from '../fomodInstaller';
import type { FomodDialog, FomodLanded, FomodStepChoice } from '../../instanceAdapter';
import type { FomodMove, FomodState } from '../../../wire/fomodPage';
import { present } from '../../../ports/present';
import { engineProcessFrom, FOMOD_ENGINE } from '../../../test/fomodEngine';

const SCHEMA = 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://qconsulting.ca/fo3/ModConfig5.0.xsd"';

const config = (body: string): string => `<?xml version="1.0" encoding="UTF-8"?><config ${SCHEMA}><moduleName>Test</moduleName>${body}</config>`;

const option = (name: string, files: string, type = 'Optional', flag = ''): string =>
  `<plugin name="${name}"><description/><files>${files}</files>${flag}<typeDescriptor><type name="${type}"/></typeDescriptor></plugin>`;

const group = (name: string, type: string, options: string): string =>
  `<group name="${name}" type="${type}"><plugins order="Explicit">${options}</plugins></group>`;

const step = (name: string, groups: string, visible = ''): string =>
  `<installStep name="${name}">${visible}<optionalFileGroups order="Explicit">${groups}</optionalFileGroups></installStep>`;

const steps = (...each: string[]): string => `<installSteps order="Explicit">${each.join('')}</installSteps>`;

const file = (source: string, destination: string): string => `<file source="${source}" destination="${destination}"/>`;

const TWO_STEPS = config(`<requiredInstallFiles><folder source="core" destination=""/></requiredInstallFiles>${steps(
  step('Main', group('Pick', 'SelectExactlyOne',
    option('Option A', file('a/A.esp', 'A.esp'), 'Optional', '<conditionFlags><flag name="picked">A</flag></conditionFlags>')
    + option('Option B', file('b/B.esp', 'textures/B.esp'), 'Recommended', '<conditionFlags><flag name="picked">B</flag></conditionFlags>'))),
  step('Only for B', group('Extras', 'SelectAny', option('Extra', file('a/A.esp', 'extra/A.esp'), 'Recommended')),
    '<visible><flagDependency flag="picked" value="B"/></visible>'),
)}`);
const TWO_STEPS_FILES = ['core/Core.esp', 'a/A.esp', 'b/B.esp'];

const KNOWN: ConditionFacts = {
  plugins: { known: { present: ['Active.esp', 'Inactive.esp'], active: ['Active.esp'] } },
  gameVersion: { unknown: 'no version in this test' },
  extenderVersion: { unknown: 'no version in this test' },
};

const choose = (...each: [string, Record<string, string[]>][]): FomodStepChoice[] =>
  each.map(([name, groups]) => ({ step: name, groups: Object.entries(groups).map(([named, options]) => ({ group: named, options })) }));

async function filesIn(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(folder.length + 1).replaceAll('\\', '/')).sort();
}

describe('the FOMOD installer', () => {
  let base: string;
  let root: string;
  let landedIn: string | undefined;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'fomod-'));
    root = join(base, 'release');
    landedIn = undefined;
  });
  afterEach(() => rm(base, { recursive: true, force: true }));

  async function release(moduleConfig: string, files: readonly string[]): Promise<void> {
    for (const path of [...files, 'fomod/ModuleConfig.xml']) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), path === 'fomod/ModuleConfig.xml' ? moduleConfig : `bytes of ${path}`);
    }
  }

  async function install(choices: readonly FomodStepChoice[], engine: FomodEngine = FOMOD_ENGINE): Promise<FomodLanded> {
    const landing = await fomodLanding(engine, { root, fomod: 'xml' }, { kind: 'choices', steps: choices }, () => Promise.resolve(KNOWN));
    if ('cancelled' in landing) throw new Error('The installer was cancelled.');
    landedIn = landing.root;
    return landing.fomod;
  }
  const filesLanded = (): Promise<string[]> => filesIn(present(landedIn, 'the folder the files landed in'));
  const releaseLeftAsItWas = async (files: readonly string[]): Promise<void> => {
    expect(await filesIn(root)).toEqual([...files, 'fomod/ModuleConfig.xml'].sort());
  };

  it('lands the files the choices select, each at its destination, and asks no step whose condition does not hold', async () => {
    await release(TWO_STEPS, TWO_STEPS_FILES);

    expect(await install(choose(['Main', { Pick: ['Option A'] }]))).toEqual({ kind: 'installer', missing: [], notes: [] });
    expect(await filesLanded()).toEqual(['A.esp', 'Core.esp']);
  });

  it('asks each step the choices show, and takes none of the author\'s defaults', async () => {
    await release(TWO_STEPS, TWO_STEPS_FILES);

    await install(choose(['Main', { Pick: ['Option B'] }], ['Only for B', {}]));

    expect(await filesLanded()).toEqual(['Core.esp', 'textures/B.esp']);
  });

  it('refuses choices that leave a step it shows unanswered, listing the step\'s groups and options, and lands nothing', async () => {
    await release(TWO_STEPS, TWO_STEPS_FILES);

    await expect(install(choose(['Main', { Pick: ['Option B'] }]))).rejects.toThrow(
      'The choices leave step "Only for B" unanswered. Step "Only for B": group "Extras" takes any of "Extra" (recommended).',
    );
    await releaseLeftAsItWas(TWO_STEPS_FILES);
  });

  it('refuses no choices at all, listing the first step', async () => {
    await release(TWO_STEPS, TWO_STEPS_FILES);

    await expect(install([])).rejects.toThrow(
      'The choices leave step "Main" unanswered. Step "Main": group "Pick" takes exactly one of "Option A", "Option B" (recommended).',
    );
  });

  it.each([
    ['two', ['Option A', 'Option B'], 2],
    ['none', [], 0],
  ])('refuses %s picked in a group that takes exactly one', async (_, picked, count) => {
    await release(TWO_STEPS, TWO_STEPS_FILES);

    await expect(install(choose(['Main', { Pick: picked }]))).rejects.toThrow(
      `Group "Pick" of step "Main" takes exactly one, and the choices pick ${count}.`,
    );
  });

  it.each([
    ['a group', choose(['Main', { Pik: ['Option A'] }]), 'Step "Main" has no group "Pik".'],
    ['an option', choose(['Main', { Pick: ['Option C'] }]), 'Group "Pick" of step "Main" has no option "Option C".'],
  ])('refuses %s the step does not have', async (_, choices, refusal) => {
    await release(TWO_STEPS, TWO_STEPS_FILES);

    await expect(install(choices)).rejects.toThrow(refusal);
  });

  describe('each option\'s type', () => {
    const notUsableWhileActive = `<plugin name="Not usable here"><description/><files>${file('f/c.esp', 'c.esp')}</files>`
      + '<typeDescriptor><dependencyType><defaultType name="Optional"/><patterns><pattern><dependencies>'
      + '<fileDependency file="Active.esp" state="Active"/></dependencies><type name="NotUsable"/></pattern></patterns></dependencyType></typeDescriptor></plugin>';
    const TYPED = config(steps(step('Types',
      group('Any', 'SelectAny', option('Required', file('f/r.esp', 'r.esp'), 'Required')
        + option('Not usable', file('f/n.esp', 'n.esp'), 'NotUsable') + option('Optional', file('f/o.esp', 'o.esp')) + notUsableWhileActive)
      + group('All', 'SelectAll', option('One', file('f/1.esp', '1.esp')) + option('Two', file('f/2.esp', '2.esp'))))));
    const TYPED_FILES = ['f/r.esp', 'f/n.esp', 'f/o.esp', 'f/c.esp', 'f/1.esp', 'f/2.esp'];

    it('lands a required option and every option of a group that takes all, none of them named', async () => {
      await release(TYPED, TYPED_FILES);

      await install(choose(['Types', {}]));

      expect(await filesLanded()).toEqual(['1.esp', '2.esp', 'r.esp']);
    });

    it.each(['Not usable', 'Not usable here'])('refuses the pick of "%s", which its conditions make not usable', async (name) => {
      await release(TYPED, TYPED_FILES);

      await expect(install(choose(['Types', { Any: [name] }]))).rejects.toThrow(`"${name}" cannot be picked.`);
    });
  });

  it('names each file the FOMOD names and its archive lacks, and lands the rest', async () => {
    await release(config(`<requiredInstallFiles>${file('core/Core.esp', 'Core.esp')}${file('gone/Gone.esp', 'Gone.esp')}</requiredInstallFiles>`), ['core/Core.esp']);

    expect(await install([])).toEqual({ kind: 'installer', missing: ['gone/Gone.esp'], notes: [] });
    expect(await filesLanded()).toEqual(['Core.esp']);
  });

  it('finds a file its config names in another case, and lands folders named in two cases as one', async () => {
    await release(config(`<requiredInstallFiles>${file('CORE/core.ESP', 'Textures/Core.esp')}${file('core/Other.esp', 'textures/Other.esp')}</requiredInstallFiles>`),
      ['core/Core.esp', 'core/Other.esp']);

    await install([]);

    expect(await filesLanded()).toEqual(['Textures/Core.esp', 'Textures/Other.esp']);
  });

  it('refuses a FOMOD whose module dependencies do not hold, naming which, and lands nothing', async () => {
    await release(config('<moduleDependencies operator="And"><fileDependency file="Needed.esm" state="Active"/>'
      + '<fileDependency file="Active.esp" state="Active"/></moduleDependencies>'
      + `<requiredInstallFiles>${file('core/Core.esp', 'Core.esp')}</requiredInstallFiles>`), ['core/Core.esp']);

    const refusal = install([]);

    await expect(refusal).rejects.toThrow(/needed\.esm/i);
    await expect(refusal).rejects.not.toThrow(/active\.esp/i);
    await releaseLeftAsItWas(['core/Core.esp']);
  });

  it('names each folder the options chosen name and its archive lacks, and no folder of an option not chosen', async () => {
    const folder = (source: string): string => `<folder source="${source}" destination=""/>`;
    await release(config(`<requiredInstallFiles>${folder('core')}${folder('Gone Required')}</requiredInstallFiles>${steps(
      step('Main', group('Pick', 'SelectExactlyOne', option('A', folder('gone/a')) + option('B', `<folder source='gone\\b'></folder>`))))}`), ['core/Core.esp']);

    expect(await install(choose(['Main', { Pick: ['A'] }]))).toEqual({ kind: 'installer', missing: ['Gone Required', 'gone/a'], notes: [] });
    expect(await filesLanded()).toEqual(['Core.esp']);
  });

  it('reads a module config that names no schema, as MO2 reads it, and leaves the release\'s own as it was', async () => {
    const unnamed = `<config><moduleName>No schema</moduleName><requiredInstallFiles>${file('core/Core.esp', 'Core.esp')}</requiredInstallFiles></config>`;
    await release(unnamed, ['core/Core.esp']);

    expect(await install([])).toEqual({ kind: 'installer', missing: [], notes: [] });
    expect(await filesLanded()).toEqual(['Core.esp']);
    expect(await readFile(join(root, 'fomod', 'ModuleConfig.xml'), 'utf8')).toBe(unnamed);
  });

  it('lands a FOMOD whose installer cannot be read as a plain copy, saying why', async () => {
    await release('<config><moduleName>Never closed</moduleName>', ['core/Core.esp']);

    const answered = await install([]);

    expect(answered.kind === 'plainCopy' && answered.why).toMatch(/^its installer cannot be read: \S/);
    expect(landedIn).toBe(root);
    await releaseLeftAsItWas(['core/Core.esp']);
  });

  it('refuses a FOMOD that installs outside the mod\'s folder, naming where, and writes nothing there', async () => {
    await release(config(`<requiredInstallFiles>${file('core/Core.esp', 'Core.esp')}${file('core/Core.esp', '../../escaped.esp')}`
      + `${file('core/Core.esp', '..\\..\\escaped2.esp')}</requiredInstallFiles>`), ['core/Core.esp']);

    await expect(install([])).rejects.toThrow('The FOMOD installs to "../../escaped.esp", "../../escaped2.esp", outside the mod\'s folder.');
    expect(await filesIn(base)).toEqual(['release/core/Core.esp', 'release/fomod/ModuleConfig.xml']);
  });

  it('lands the file of the higher priority where two name one destination in two cases', async () => {
    const prioritised = (name: string, source: string, destination: string, priority: number): string =>
      `<plugin name="${name}"><description/><files><file source="${source}" destination="${destination}" priority="${priority}"/></files>`
      + '<typeDescriptor><type name="Optional"/></typeDescriptor></plugin>';
    await release(config(steps(step('Main', group('Pick', 'SelectAny',
      prioritised('High', 'a/A.esp', 'Same.esp', 5) + prioritised('Low', 'b/B.esp', 'same.esp', 1))))), ['a/A.esp', 'b/B.esp']);

    await install(choose(['Main', { Pick: ['High', 'Low'] }]));

    const [landed] = await filesLanded();
    expect(await readFile(join(present(landedIn, 'the folder'), present(landed, 'the one file')), 'utf8')).toBe('bytes of a/A.esp');
  });

  it('refuses a choice for a step the installer does not show, naming it', async () => {
    await release(TWO_STEPS, TWO_STEPS_FILES);

    await expect(install(choose(['Main', { Pick: ['Option A'] }], ['Only for B', {}]))).rejects.toThrow(
      'The installer shows no step "Only for B" for the choices given.',
    );
  });

  it('passes on what else its installer says, as it says it', async () => {
    await release(config(`<requiredInstallFiles>${file('core', 'core.esp')}</requiredInstallFiles>`), ['core/One.esp', 'core/Two.esp']);

    expect(await install([])).toEqual({ kind: 'installer', missing: [], notes: ['Source matches a directory, was supposed to be a file: "core"'] });
  });

  describe('an engine that fails', () => {
    beforeEach(() => release(TWO_STEPS, TWO_STEPS_FILES));

    it('refuses, naming the step, when the installer will not leave a step its choices answer', async () => {
      const repeats = { ...FOMOD_ENGINE, process: engineProcessFrom(join(__dirname, '..', '..', '..', 'test', 'fomodEngines', 'repeatsStep.ts')) };

      await expect(install(choose(['Main', { Pick: ['A'] }]), repeats)).rejects.toThrow(
        'The installer would not leave step "Main" on the choices given.',
      );
    });

    it('refuses when the engine says nothing, and stops it', async () => {
      const silent = { ...FOMOD_ENGINE, process: engineProcessFrom(join(__dirname, '..', '..', '..', 'test', 'fomodEngines', 'silent.ts')), silence: 0 };

      await expect(install([], silent)).rejects.toThrow('The FOMOD engine could not run: it said nothing for 0 ms');
    });

    it('refuses as the engine\'s fault, and lands no plain copy, when its add-on will not load', async () => {
      const unloadable = { ...FOMOD_ENGINE, folder: base };

      await expect(install([], unloadable)).rejects.toThrow(/^The FOMOD engine could not run: .*modinstaller\.napi\.node/);
      expect(landedIn).toBeUndefined();
    });
  });

  describe('conditions, read as MO2 reads them', () => {
    const conditional = (dependency: string, destination: string): string =>
      `<pattern><dependencies>${dependency}</dependencies><files>${file('core/Core.esp', destination)}</files></pattern>`;

    it('reads each plugin as active, present but not active, or missing, any other file as missing, and FOMM\'s version, as MO2 answers them', async () => {
      await release(config(`<conditionalFileInstalls><patterns>${[
        conditional('<fileDependency file="Active.esp" state="Active"/>', 'active.esp'),
        conditional('<fileDependency file="Inactive.esp" state="Inactive"/>', 'inactive.esp'),
        conditional('<fileDependency file="Inactive.esp" state="Active"/>', 'wrong.esp'),
        conditional('<fileDependency file="Gone.esp" state="Missing"/>', 'missing.esp'),
        conditional('<fileDependency file="F4SE/Plugins/Present.dll" state="Missing"/>', 'not-a-plugin.esp'),
        conditional('<fommDependency version="0.13.21"/>', 'fomm.esp'),
        conditional('<fommDependency version="0.13.22"/>', 'newer-fomm.esp'),
      ].join('')}</patterns></conditionalFileInstalls>`), ['core/Core.esp']);

      await install([]);

      expect(await filesLanded()).toEqual(['active.esp', 'fomm.esp', 'inactive.esp', 'missing.esp', 'not-a-plugin.esp']);
    });

    it('refuses a FOMOD whose conditions read what could not be read, naming it and why', async () => {
      await release(config(`<conditionalFileInstalls><patterns>${conditional('<gameDependency version="1.10.163.0"/>', 'game.esp')}</patterns></conditionalFileInstalls>`),
        ['core/Core.esp']);

      await expect(install([])).rejects.toThrow('The FOMOD\'s conditions read the game\'s version, which could not be read: no version in this test.');
    });
  });

  describe('answered by the user on a page', () => {
    interface Page {
      readonly states: FomodState[];
      readonly confirmed: (string[])[];
      readonly asking: boolean[];
      closed: number;
    }

    async function answered(
      react: (state: FomodState, move: (move: FomodMove) => void, seen: number) => void,
      { engine = FOMOD_ENGINE, confirms = true }: { engine?: FomodEngine; confirms?: boolean } = {},
    ): Promise<{ page: Page; landing: Awaited<ReturnType<typeof fomodLanding>> }> {
      const page: Page = { states: [], confirmed: [], asking: [], closed: 0 };
      let handler: ((move: FomodMove) => void) | undefined;
      const dialog: FomodDialog = {
        show: (state) => {
          page.states.push(state);
          const seen = page.states.length;
          setImmediate(() => react(state, (move) => present(handler, 'the installer\'s listener')(move), seen));
        },
        onMove: (listener) => {
          handler = listener;
        },
        confirmMissing: (missing) => {
          page.confirmed.push([...missing]);
          return Promise.resolve(confirms);
        },
        asking: (asking) => {
          page.asking.push(asking);
        },
        close: () => {
          page.closed += 1;
        },
      };
      const landing = await fomodLanding(engine, { root, fomod: 'xml' }, { kind: 'dialog', dialog }, () => Promise.resolve(KNOWN));
      if ('root' in landing) landedIn = landing.root;
      return { page, landing };
    }
    const idOf = (state: FomodState, step: string, group: string, option: string): { stepId: number; groupId: number; optionId: number } => {
      const found = present(state.steps.find(({ name }) => name === step), `step ${step}`);
      const inGroup = present(found.optionalFileGroups?.group.find(({ name }) => name === group), `group ${group}`);
      return { stepId: found.id, groupId: inGroup.id, optionId: present(inGroup.options.find(({ name }) => name === option), option).id };
    };
    const pick = (option: string) => (state: FomodState, move: (move: FomodMove) => void): void => {
      const { stepId, groupId, optionId } = idOf(state, 'Main', 'Pick', option);
      move({ kind: 'select', stepId, groupId, optionIds: [optionId] });
    };

    it('shows the installer as it stands after each click, then lands the files of the choices when Install is clicked', async () => {
      await release(TWO_STEPS, TWO_STEPS_FILES);
      const visibleSteps = (state: FomodState): string[] => state.steps.filter(({ visible }) => visible).map(({ name }) => name);

      const { page, landing } = await answered((state, move, seen) => {
        if (seen === 1) pick('Option A')(state, move);
        else move({ kind: 'continue', forward: true, stepId: 0 });
      });

      expect(page.states.map(visibleSteps)).toEqual([['Main', 'Only for B'], ['Main']]);
      expect(landing).toMatchObject({ fomod: { kind: 'installer', missing: [], notes: [] } });
      expect(await filesLanded()).toEqual(['A.esp', 'Core.esp']);
      expect(page.closed).toBe(1);
    });

    it('moves on to the next step visible, and reports the installer module on every state', async () => {
      await release(TWO_STEPS, TWO_STEPS_FILES);

      const { page, landing } = await answered((_, move, seen) => move({ kind: 'continue', forward: true, stepId: seen - 1 }));

      expect(page.states.map(({ module, current }) => [module, current])).toEqual([['Test', 0], ['Test', 1]]);
      expect(await filesLanded()).toEqual(['Core.esp', 'extra/A.esp', 'textures/B.esp']);
      expect(landing).toMatchObject({ fomod: { kind: 'installer' } });
    });

    it('keeps the choices when the user goes Back', async () => {
      await release(TWO_STEPS, TWO_STEPS_FILES);

      const { page } = await answered((state, move, seen) => {
        if (seen === 1) pick('Option B')(state, move);
        else if (seen === 2) move({ kind: 'continue', forward: true, stepId: 0 });
        else if (seen === 3) move({ kind: 'continue', forward: false, stepId: 1 });
        else move({ kind: 'cancel' });
      });

      const back = present(page.states[3], 'the state after Back');
      expect(back.current).toBe(0);
      expect(back.steps[0]?.optionalFileGroups?.group[0]?.options.map(({ selected }) => selected)).toEqual([false, true]);
    });

    it('installs nothing, and says so, when the user cancels', async () => {
      await release(TWO_STEPS, TWO_STEPS_FILES);

      const { page, landing } = await answered((_, move) => move({ kind: 'cancel' }));

      expect(landing).toEqual({ cancelled: true });
      expect(page.closed).toBe(1);
      await releaseLeftAsItWas(TWO_STEPS_FILES);
    });

    it('lands the release as it is, with no reason to give, when the user picks Manual', async () => {
      await release(TWO_STEPS, TWO_STEPS_FILES);

      const { landing } = await answered((_, move) => move({ kind: 'manual' }));

      expect(landing).toEqual({ root, fomod: { kind: 'manual' } });
    });

    it('shows the header and Install alone for a FOMOD with no step to see, and lands its files when Install is clicked', async () => {
      await release(config(`<requiredInstallFiles>${file('core/Core.esp', 'Core.esp')}</requiredInstallFiles>`), ['core/Core.esp']);

      const { page, landing } = await answered((_, move) => move({ kind: 'continue', forward: true, stepId: 0 }));

      expect(page.states).toEqual([{ module: 'Test', steps: [], current: 0 }]);
      expect(landing).toMatchObject({ fomod: { kind: 'installer' } });
      expect(await filesLanded()).toEqual(['Core.esp']);
    });

    it('installs nothing when the user cancels a FOMOD with no step to see', async () => {
      await release(config(`<requiredInstallFiles>${file('core/Core.esp', 'Core.esp')}</requiredInstallFiles>`), ['core/Core.esp']);

      const { landing } = await answered((_, move) => move({ kind: 'cancel' }));

      expect(landing).toEqual({ cancelled: true });
    });

    it('waits on the user for as long as the user takes, though the engine says nothing', async () => {
      await release(TWO_STEPS, TWO_STEPS_FILES);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const { landing } = await answered((_, move) => {
          vi.advanceTimersByTime(FOMOD_ENGINE.silence * 10);
          move({ kind: 'cancel' });
        });

        expect(landing).toEqual({ cancelled: true });
      } finally {
        vi.useRealTimers();
      }
    });

    it('says the user is being asked from the first state shown until the user\'s last move, and not while it lands', async () => {
      await release(TWO_STEPS, TWO_STEPS_FILES);

      const { page } = await answered((_, move, seen) => move({ kind: 'continue', forward: true, stepId: seen - 1 }));

      expect(page.asking).toEqual([true, true, false]);
    });

    it('says the user is being asked while the missing files are confirmed, and not after', async () => {
      await release(config(`<requiredInstallFiles>${file('core/Core.esp', 'Core.esp')}${file('gone/Gone.esp', 'Gone.esp')}</requiredInstallFiles>`), ['core/Core.esp']);

      const { page } = await answered((_, move) => move({ kind: 'continue', forward: true, stepId: 0 }));

      expect(page.asking).toEqual([true, false, true, false]);
    });

    describe('a file the FOMOD names and its archive lacks', () => {
      const LACKING = config(`<requiredInstallFiles>${file('core/Core.esp', 'Core.esp')}${file('gone/Gone.esp', 'Gone.esp')}</requiredInstallFiles>`);

      it('is named to the user, who may install without it', async () => {
        await release(LACKING, ['core/Core.esp']);

        const { page, landing } = await answered((_, move) => move({ kind: 'continue', forward: true, stepId: 0 }));

        expect(page.confirmed).toEqual([['gone/Gone.esp']]);
        expect(landing).toMatchObject({ fomod: { kind: 'installer', missing: ['gone/Gone.esp'] } });
        expect(await filesLanded()).toEqual(['Core.esp']);
      });

      it('installs nothing when the user cancels the confirmation', async () => {
        await release(LACKING, ['core/Core.esp']);

        const { landing } = await answered((_, move) => move({ kind: 'continue', forward: true, stepId: 0 }), { confirms: false });

        expect(landing).toEqual({ cancelled: true });
        await releaseLeftAsItWas(['core/Core.esp']);
      });
    });

    it('closes the page, and refuses, when the module dependencies do not hold', async () => {
      await release(config('<moduleDependencies operator="And"><fileDependency file="Needed.esm" state="Active"/></moduleDependencies>'), ['core/Core.esp']);
      const closed = { count: 0 };
      const dialog: FomodDialog = { show: () => undefined, onMove: () => undefined, confirmMissing: () => Promise.resolve(true), asking: () => undefined, close: () => { closed.count += 1; } };

      await expect(fomodLanding(FOMOD_ENGINE, { root, fomod: 'xml' }, { kind: 'dialog', dialog }, () => Promise.resolve(KNOWN))).rejects.toThrow(/needed\.esm/i);
      expect(closed.count).toBe(1);
    });
  });
});
