import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fomodLanding, type ConditionFacts, type FomodEngine } from '../fomodInstaller';
import type { FomodDialog, FomodLanded, FomodStepChoice } from '../../instanceAdapter';
import type { FomodMove, FomodState, ReleaseImage } from '../../../wire/fomodPage';
import { present } from '../../../ports/present';
import { engineProcessFrom, FOMOD_ENGINE } from '../../../test/fomodEngine';
import { FOMOD_PAGE } from '../../../test/fomodDialogDouble';

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

const utf16le = (text: string): Buffer => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
const utf16be = (text: string): Buffer => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);

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

  async function release(moduleConfig: string | Buffer, files: readonly string[]): Promise<void> {
    for (const path of [...files, 'fomod/ModuleConfig.xml']) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), path === 'fomod/ModuleConfig.xml' ? moduleConfig : `bytes of ${path}`);
    }
  }

  async function install(choices: readonly FomodStepChoice[], engine: FomodEngine = FOMOD_ENGINE): Promise<FomodLanded> {
    const landing = await fomodLanding(engine, { root, fomod: 'xml' }, { kind: 'choices', steps: choices }, () => Promise.resolve(KNOWN));
    if (landing.kind === 'cancelled') throw new Error('The installer was cancelled.');
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

  it.each([
    ['UTF-16 little-endian, by its byte order mark', '<?xml version="1.0" encoding="UTF-16"?>', utf16le],
    ['UTF-16 big-endian, by its byte order mark', '<?xml version="1.0" encoding="UTF-16"?>', utf16be],
    ['UTF-16 little-endian with no byte order mark, by its first characters', '<?xml version="1.0" encoding="UTF-16"?>', (text: string) => Buffer.from(text, 'utf16le')],
    ['neither UTF-8 nor UTF-16, as Windows-1252, where MO2 falls back to Latin-1', '<?xml version="1.0"?>', (text: string) => Buffer.from(text, 'latin1')],
  ])('reads a module config in %s, as MO2 reads it, though it names no schema and a folder its archive lacks', async (_, declaration, encoded) => {
    const unnamed = encoded(`${declaration}<config><moduleName>No schema</moduleName><requiredInstallFiles>`
      + `${file('core/Core.esp', 'Café.esp')}<folder source="gone" destination=""/></requiredInstallFiles></config>`);
    await release(unnamed, ['core/Core.esp']);

    expect(await install([])).toEqual({ kind: 'installer', missing: ['gone'], notes: [] });
    expect(await filesLanded()).toEqual(['Café.esp']);
    expect(await readFile(join(root, 'fomod', 'ModuleConfig.xml'))).toEqual(unnamed);
  });

  it.each([
    ['never closed', '<config><moduleName>Never closed</moduleName>', 'line 1, column 175'],
    ['not XML', 'not xml', 'line 1, column 1'],
  ])('lands a FOMOD whose module config is %s as a plain copy, saying the config is not well-formed XML and where', async (_, config, where) => {
    await release(config, ['core/Core.esp']);

    const answered = await install([]);

    expect(answered).toEqual({ kind: 'plainCopy', why: `its installer cannot be read: fomod/ModuleConfig.xml is not well-formed XML, at ${where}` });
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

      await expect(install([], unloadable)).rejects.toThrow(/^The FOMOD engine could not run: ./);
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

    describe('a condition that reads what could not be read', () => {
      const gated = (dependency: string, otherwise = 'NotUsable', before = ''): string =>
        `<plugin name="Gated"><description/><files>${file('f/g.esp', 'g.esp')}</files><typeDescriptor><dependencyType><defaultType name="${otherwise}"/>`
        + `<patterns>${before}<pattern><dependencies>${dependency}</dependencies><type name="Optional"/></pattern></patterns></dependencyType></typeDescriptor></plugin>`;
      const GAME_AT_INSTALL = config(`<conditionalFileInstalls><patterns>${conditional('<gameDependency version="1.10.163.0"/>', 'game.esp')}`
        + `${conditional('<gameDependency version="1.10.164.0"/>', 'newer.esp')}</patterns></conditionalFileInstalls>`);
      const GAME_IN_OPTION = config(steps(step('Start', group('Pick', 'SelectAny', gated('<gameDependency version="1.0"/>')))));
      const GAME_AND_EXTENDER_IN_OPTION = config(steps(step('Start', group('Pick', 'SelectAny',
        gated('<dependencies operator="And"><gameDependency version="1.0"/><foseDependency version="1.0.0.0"/></dependencies>')))));
      const PLUGIN_IN_OPTION =config(steps(step('Start', group('Pick', 'SelectAny', gated('<fileDependency file="Active.esp" state="Active"/>')))));
      const UNSET = '<pattern><dependencies><flagDependency flag="picked" value=""/></dependencies><type name="Optional"/></pattern>';
      const AFTER_A_PICK = config(steps(step('Start',
        group('First', 'SelectAny', option('Sets flag', file('f/s.esp', 's.esp'), 'Optional', '<conditionFlags><flag name="picked">A</flag></conditionFlags>'))
        + group('Second', 'SelectAny', gated('<gameDependency version="1.0"/>', 'NotUsable', UNSET)))));
      const GAME = 'The FOMOD\'s conditions read the game\'s version, which could not be read: no version in this test.';

      it.each([
        ['at Install', GAME_AT_INSTALL, KNOWN, [], GAME],
        ['by an option\'s type, before any step is answered', GAME_IN_OPTION, KNOWN, [], GAME],
        ['by an option\'s type once a pick changes it, though more picks follow', AFTER_A_PICK, KNOWN,
          choose(['Start', { First: ['Sets flag'], Second: [] }]), GAME],
        ['of the game and of its script extender, naming both', GAME_AND_EXTENDER_IN_OPTION, KNOWN, [],
          'The FOMOD\'s conditions read the game\'s version, which could not be read: no version in this test; '
          + 'the script extender\'s version, which could not be read: no version in this test.'],
        ['of the plugins',PLUGIN_IN_OPTION, { ...KNOWN, plugins: { unknown: 'no plugins in this test' } }, [],
          'The FOMOD\'s conditions read the plugins, which could not be read: no plugins in this test.'],
      ])('refuses what is read %s, naming why', async (_, moduleConfig, facts, choices, refusal) => {
        await release(moduleConfig, ['f/g.esp', 'f/s.esp', 'core/Core.esp']);

        await expect(fomodLanding(FOMOD_ENGINE, { root, fomod: 'xml' }, { kind: 'choices', steps: choices }, () => Promise.resolve(facts)))
          .rejects.toThrow(new Error(refusal));
      });

      it('shows the page no step', async () => {
        await release(GAME_IN_OPTION, ['f/g.esp']);
        const show = vi.fn();
        const dialog: FomodDialog = { ...FOMOD_PAGE, show };

        await expect(fomodLanding(FOMOD_ENGINE, { root, fomod: 'xml' }, { kind: 'dialog', dialog }, () => Promise.resolve(KNOWN)))
          .rejects.toThrow(new Error(GAME));
        expect(show).not.toHaveBeenCalled();
      });
    });
  });

  describe('answered by the user on a page', () => {
    interface Page {
      readonly states: FomodState<ReleaseImage>[];
      readonly roots: string[];
      readonly confirmed: (string[])[];
      readonly asking: boolean[];
      closed: number;
    }

    type Reply = FomodMove | ((state: FomodState<ReleaseImage>) => FomodMove);
    const INSTALL: FomodMove = { kind: 'continue', forward: true, stepId: 0 };
    const CANCEL: FomodMove = { kind: 'cancel' };

    async function answered(
      replies: readonly Reply[],
      { engine = FOMOD_ENGINE, confirms = true, onShow = () => undefined }: { engine?: FomodEngine; confirms?: boolean; onShow?: () => void } = {},
    ): Promise<{ page: Page; landing: Awaited<ReturnType<typeof fomodLanding>> }> {
      const page: Page = { states: [], roots: [], confirmed: [], asking: [], closed: 0 };
      let handler: ((move: FomodMove) => void) | undefined;
      const dialog: FomodDialog = {
        ...FOMOD_PAGE,
        show: (state, shownRoot) => {
          page.roots.push(shownRoot);
          const reply = present(replies[Math.min(page.states.length, replies.length - 1)], 'the reply to this state');
          page.states.push(state);
          setImmediate(() => {
            onShow();
            present(handler, 'the installer\'s listener')(typeof reply === 'function' ? reply(state) : reply);
          });
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
      if (landing.kind === 'landing') landedIn = landing.root;
      return { page, landing };
    }
    const idOf = (state: FomodState<ReleaseImage>, step: string, group: string, option: string): { stepId: number; groupId: number; optionId: number } => {
      const found = present(state.steps.find(({ name }) => name === step), `step ${step}`);
      const inGroup = present(found.optionalFileGroups?.group.find(({ name }) => name === group), `group ${group}`);
      return { stepId: found.id, groupId: inGroup.id, optionId: present(inGroup.options.find(({ name }) => name === option), option).id };
    };
    const pick = (option: string) => (state: FomodState<ReleaseImage>): FomodMove => {
      const { stepId, groupId, optionId } = idOf(state, 'Main', 'Pick', option);
      return { kind: 'select', stepId, groupId, optionIds: [optionId] };
    };

    it('shows the installer as it stands after each click, then lands the files of the choices when Install is clicked', async () => {
      await release(TWO_STEPS, TWO_STEPS_FILES);
      const visibleSteps = (state: FomodState<ReleaseImage>): string[] => state.steps.filter(({ visible }) => visible).map(({ name }) => name);

      const { page, landing } = await answered([pick('Option A'), INSTALL]);

      expect(page.states.map(visibleSteps)).toEqual([['Main', 'Only for B'], ['Main']]);
      expect(landing).toMatchObject({ fomod: { kind: 'installer', missing: [], notes: [] } });
      expect(await filesLanded()).toEqual(['A.esp', 'Core.esp']);
      expect(page.closed).toBe(1);
    });

    describe('its header, descriptions and images', () => {
      const INFO = '<fomod><Name>Info name</Name><Author><![CDATA[Ada & <Bo>]]></Author><Version MachineVersion="1.2.3">1.2</Version><Website>https://example.com/m</Website></fomod>';
      const imaged = (headerImage: string, optionImage: string): string => config(
        `<moduleImage path="${headerImage}"/>${steps(step('Main', group('Pick', 'SelectExactlyOne',
          `<plugin name="A"><description>About A</description><image path="${optionImage}"/><files>${file('a/A.esp', 'A.esp')}</files>`
          + '<typeDescriptor><type name="Optional"/></typeDescriptor></plugin>')))}`);
      const shown = async (moduleConfig: string, files: readonly string[]): Promise<{ state: FomodState<ReleaseImage>; root: string }> => {
        await release(moduleConfig, ['a/A.esp', ...files]);
        const { page } = await answered([INSTALL]);
        return { state: present(page.states[0], 'the first state'), root: present(page.roots[0], 'the root it was shown with') };
      };
      const imageOf = (state: FomodState<ReleaseImage>): ReleaseImage => state.steps[0]?.optionalFileGroups?.group[0]?.options[0]?.image;

      it('carries the author, version and website of the FOMOD\'s info file, found as the release spells it', async () => {
        await release(imaged('', ''), ['a/A.esp']);
        await mkdir(join(root, 'FOMOD'), { recursive: true });
        await writeFile(join(root, 'FOMOD', 'Info.XML'), INFO);

        const { page } = await answered([INSTALL]);

        expect(page.states[0]).toMatchObject({ module: 'Test', author: 'Ada & <Bo>', version: '1.2', website: 'https://example.com/m' });
      });

      const cyrillicInWindows1251 = (text: string): Buffer =>
        Buffer.from(Array.from({ length: text.length }, (_, i) => {
          const code = text.charCodeAt(i);
          return code >= 0x410 && code <= 0x44f ? code - 0x410 + 0xc0 : code;
        }));

      it.each([
        ['UTF-8 with a byte order mark', 'Adé', (text: string): Buffer => Buffer.from(`\uFEFF${text}`)],
        ['UTF-8, of an even length that UTF-16 would decode, whose declaration names UTF-16', 'Adé', (text: string): Buffer => {
          const declared = `<?xml version="1.0" encoding="UTF-16"?>${text}`;
          return Buffer.from(Buffer.byteLength(declared) % 2 === 0 ? declared : `${declared}\n`);
        }],
        ['UTF-16 little-endian, by its byte order mark', 'Adé', utf16le],
        ['UTF-16 big-endian, by its byte order mark', 'Adé', utf16be],
        ['UTF-16 little-endian with no byte order mark, by its first characters', 'Adé', (text: string): Buffer => Buffer.from(`<?xml version="1.0"?>${text}`, 'utf16le')],
        ['the encoding its declaration names', 'Иван', (text: string): Buffer => cyrillicInWindows1251(`<?xml version="1.0" encoding="windows-1251"?>${text}`)],
        ['neither UTF-8 nor UTF-16 and naming none, as Windows-1252, where MO2 falls back to Latin-1', 'Adé', (text: string): Buffer => Buffer.from(text, 'latin1')],
      ])('reads an info file in %s', async (_, author, encoded) => {
        await release(imaged('', ''), ['a/A.esp']);
        await writeFile(join(root, 'fomod', 'info.xml'), encoded(INFO.replace('Ada', author)));

        const { page } = await answered([INSTALL]);

        expect(page.states[0]).toMatchObject({ author: `${author} & <Bo>`, version: '1.2', website: 'https://example.com/m' });
      });

      it('leaves a header field empty when the FOMOD gives no info file', async () => {
        const { state } = await shown(imaged('', ''), []);

        expect(state).toMatchObject({ author: '', version: '', website: '' });
      });

      it('names the header image and an option\'s image as the release spells them, whatever case and slash the FOMOD wrote', async () => {
        const { state } = await shown(imaged('Images\\HEADER.png', 'PICS/a.PNG'), ['Images/Header.png', 'pics/A.png']);

        expect(state.image).toEqual({ path: 'Images/Header.png' });
        expect(imageOf(state)).toEqual({ path: 'pics/A.png' });
        expect(state.steps[0]?.optionalFileGroups?.group[0]?.options[0]?.description).toBe('About A');
      });

      it.each([
        ['one the release lacks', 'nothing.png'],
        ['one outside the release', '../outside.png'],
        ['one that climbs out and back in', 'img/../../release/img/a.png'],
        ['an absolute one', '/etc/hostname'],
        ['a drive path', 'C:\\Windows\\win.ini'],
      ])('shows no image for %s', async (_, path) => {
        await writeFile(join(base, 'outside.png'), 'outside');
        const { state } = await shown(imaged(path, path), ['img/a.png']);

        expect(state.image).toBeUndefined();
        expect(imageOf(state)).toBeUndefined();
      });

      it('shows the page the folder of the release, where its images are', async () => {
        const { root: shownRoot } = await shown(imaged('', ''), []);

        expect(shownRoot).toBe(root);
      });
    });

    it('moves on to the next step visible, and reports the installer module on every state', async () => {
      await release(TWO_STEPS, TWO_STEPS_FILES);

      const { page, landing } = await answered([INSTALL, { kind: 'continue', forward: true, stepId: 1 }]);

      expect(page.states.map(({ module, current }) => [module, current])).toEqual([['Test', 0], ['Test', 1]]);
      expect(await filesLanded()).toEqual(['Core.esp', 'extra/A.esp', 'textures/B.esp']);
      expect(landing).toMatchObject({ fomod: { kind: 'installer' } });
    });

    it('keeps the choices when the user goes Back', async () => {
      await release(TWO_STEPS, TWO_STEPS_FILES);

      const { page } = await answered([pick('Option B'), INSTALL, { kind: 'continue', forward: false, stepId: 1 }, CANCEL]);

      const back = present(page.states[3], 'the state after Back');
      expect(back.current).toBe(0);
      expect(back.steps[0]?.optionalFileGroups?.group[0]?.options.map(({ selected }) => selected)).toEqual([false, true]);
    });

    it('installs nothing, and says so, when the user cancels', async () => {
      await release(TWO_STEPS, TWO_STEPS_FILES);

      const { page, landing } = await answered([CANCEL]);

      expect(landing).toEqual({ kind: 'cancelled' });
      expect(page.closed).toBe(1);
      await releaseLeftAsItWas(TWO_STEPS_FILES);
    });

    it('lands the release as a plain copy, saying Manual was asked for, when the user picks Manual', async () => {
      await release(TWO_STEPS, TWO_STEPS_FILES);

      const { landing } = await answered([{ kind: 'manual' }]);

      expect(landing).toEqual({ kind: 'landing', root, fomod: { kind: 'plainCopy', why: 'Manual was asked for' } });
    });

    it('shows the header and Install alone for a FOMOD with no step to see, and lands its files when Install is clicked', async () => {
      await release(config(`<requiredInstallFiles>${file('core/Core.esp', 'Core.esp')}</requiredInstallFiles>`), ['core/Core.esp']);

      const { page, landing } = await answered([INSTALL]);

      expect(page.states).toEqual([{ module: 'Test', author: '', version: '', website: '', image: undefined, steps: [], current: 0 }]);
      expect(landing).toMatchObject({ fomod: { kind: 'installer' } });
      expect(await filesLanded()).toEqual(['Core.esp']);
    });

    it('installs nothing when the user cancels a FOMOD with no step to see', async () => {
      await release(config(`<requiredInstallFiles>${file('core/Core.esp', 'Core.esp')}</requiredInstallFiles>`), ['core/Core.esp']);

      const { landing } = await answered([CANCEL]);

      expect(landing).toEqual({ kind: 'cancelled' });
    });

    it('waits on the user for as long as the user takes, though the engine says nothing', async () => {
      await release(TWO_STEPS, TWO_STEPS_FILES);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const { landing } = await answered([CANCEL], { onShow: () => vi.advanceTimersByTime(FOMOD_ENGINE.silence * 10) });

        expect(landing).toEqual({ kind: 'cancelled' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('says the user is being asked from the first state shown until the user\'s last move, and not while it lands', async () => {
      await release(TWO_STEPS, TWO_STEPS_FILES);

      const { page } = await answered([INSTALL, { kind: 'continue', forward: true, stepId: 1 }]);

      expect(page.asking).toEqual([true, true, false]);
    });

    it('says the user is being asked while the missing files are confirmed, and not after', async () => {
      await release(config(`<requiredInstallFiles>${file('core/Core.esp', 'Core.esp')}${file('gone/Gone.esp', 'Gone.esp')}</requiredInstallFiles>`), ['core/Core.esp']);

      const { page } = await answered([INSTALL]);

      expect(page.asking).toEqual([true, false, true, false]);
    });

    describe('a file the FOMOD names and its archive lacks', () => {
      const LACKING = config(`<requiredInstallFiles>${file('core/Core.esp', 'Core.esp')}${file('gone/Gone.esp', 'Gone.esp')}</requiredInstallFiles>`);

      it('is named to the user, who may install without it', async () => {
        await release(LACKING, ['core/Core.esp']);

        const { page, landing } = await answered([INSTALL]);

        expect(page.confirmed).toEqual([['gone/Gone.esp']]);
        expect(landing).toMatchObject({ fomod: { kind: 'installer', missing: ['gone/Gone.esp'] } });
        expect(await filesLanded()).toEqual(['Core.esp']);
      });

      it('installs nothing when the user cancels the confirmation', async () => {
        await release(LACKING, ['core/Core.esp']);

        const { landing } = await answered([INSTALL], { confirms: false });

        expect(landing).toEqual({ kind: 'cancelled' });
        await releaseLeftAsItWas(['core/Core.esp']);
      });
    });

    it('closes the page, and refuses, when the module dependencies do not hold', async () => {
      await release(config('<moduleDependencies operator="And"><fileDependency file="Needed.esm" state="Active"/></moduleDependencies>'), ['core/Core.esp']);
      const close = vi.fn();

      await expect(fomodLanding(FOMOD_ENGINE, { root, fomod: 'xml' }, { kind: 'dialog', dialog: { ...FOMOD_PAGE, close } }, () => Promise.resolve(KNOWN)))
        .rejects.toThrow(/needed\.esm/i);
      expect(close).toHaveBeenCalledTimes(1);
    });
  });
});
