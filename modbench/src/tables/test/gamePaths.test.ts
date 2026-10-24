import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  archiveListsOf, ba2VersionsOf, creationClubListFile, gameReleaseForGame, loadedWithNoLineOf, nexusDomainsForGame, shortNameForNexusDomain, nexusDomainForMetaGame, gamePathInfoForRelease, pluginCompanionRule, SCRIPT_EXTENDER_FOLDERS, type PluginCompanionRule,
} from '../gamePaths';

const NOT_WRITTEN = 'a game whose plugins.txt Modbench does not write';

describe('gameReleaseForGame', () => {
  it.each([
    ['Fallout 4', 'Fallout4'],
    ['Fallout 4 VR', 'Fallout4VR'],
    ['Skyrim Special Edition', 'SkyrimSE'],
    ['Skyrim VR', 'SkyrimVR'],
    ['Starfield', 'Starfield'],
  ])('maps %s, as an instance\'s settings spell it, to Mutagen\'s release name %s', (game, release) => {
    expect(gameReleaseForGame(game)).toBe(release);
  });

  it.each([
    ['Skyrim', NOT_WRITTEN],
    ['Enderal', NOT_WRITTEN],
    ['Oblivion', NOT_WRITTEN],
    ['Fallout 3', NOT_WRITTEN],
    ['Fallout New Vegas', NOT_WRITTEN],
    ['Morrowind', 'a game Mutagen has no release for, as every value must be a name the backend\'s Enum.TryParse<GameRelease> accepts'],
    ['Some Game', 'an unknown game, never a guess'],
    ['', 'an empty name, never a guess'],
  ])('answers undefined for "%s", %s', (game) => {
    expect(gameReleaseForGame(game)).toBeUndefined();
  });
});

describe('ba2VersionsOf', () => {
  it.each([
    ['Fallout4', { general: 1, textures: 1 }],
    ['Fallout4VR', { general: 1, textures: 1 }],
    ['Starfield', undefined],
    ['SkyrimSE', undefined],
  ])('answers the BA2 versions %s\'s archives pack as, and none for a release whose archives mEdit is not known to write so the game loads them', (release, variants) => {
    expect(ba2VersionsOf(release)).toEqual(variants);
  });
});

describe('nexusDomainForMetaGame', () => {
  it.each([
    ['Fallout 4', 'fallout4'],
    ['SkyrimSE', 'skyrimspecialedition'],
    ['Skyrim Special Edition', 'skyrimspecialedition'],
    ['Fallout 4 VR', 'fallout4'],
    ['SkyrimVR', 'skyrimspecialedition'],
  ])('maps %s, as a mod\'s or a downloaded file\'s metadata spells it, to its Nexus domain', (game, domain) => {
    expect(nexusDomainForMetaGame(game)).toBe(domain);
  });

  it.each(['EnderalSE', 'Enderal Special Edition', 'Morrowind', 'Some Game'])('gives %s no domain, never a guess from its name', (game) => {
    expect(nexusDomainForMetaGame(game)).toBeUndefined();
  });
});

describe('gamePathInfoForRelease', () => {
  it.each([
    ['Fallout4', 'fallout4', '377160', 'Fallout 4'],
    ['SkyrimSE', 'skyrimspecialedition', '489830', 'Skyrim Special Edition'],
    ['Starfield', 'starfield', '1716740', 'Starfield'],
  ])('answers %s\'s Nexus slug and Steam install facts', (release, nexusSlug, steamAppId, steamFolderName) => {
    expect(gamePathInfoForRelease(release)).toMatchObject({ nexusSlug, steamAppId, steamFolderName });
  });

  it('answers no Steam facts for a release the table only knows the Nexus slug for, the autodetector\'s signal to give up rather than guess a folder', () => {
    const info = gamePathInfoForRelease('SkyrimVR');
    expect(info).toMatchObject({ gameName: 'Skyrim VR', nexusSlug: 'skyrimspecialedition' });
    expect(info?.steamAppId).toBeUndefined();
    expect(info?.steamFolderName).toBeUndefined();
  });

  it('answers undefined for a release the table holds no row for', () => {
    expect(gamePathInfoForRelease('SomeRelease')).toBeUndefined();
  });
});

describe('SCRIPT_EXTENDER_FOLDERS', () => {
  it('holds the script-extender folder of Starfield', () => {
    expect(SCRIPT_EXTENDER_FOLDERS.has('sfse')).toBe(true);
  });
});

describe('loadedWithNoLineOf', () => {
  it.each<[string, string | undefined, string[]]>([
    ['Fallout4', 'Fallout4', [
      'Fallout4.esm', 'DLCRobot.esm', 'DLCworkshop01.esm', 'DLCCoast.esm', 'DLCworkshop02.esm', 'DLCworkshop03.esm',
      'DLCNukaWorld.esm',
    ]],
    ['SkyrimSE', 'SkyrimSE', ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm']],
    ['Starfield', 'Starfield', [
      'Starfield.esm', 'Constellation.esm', 'OldMars.esm', 'BlueprintShips-Starfield.esm', 'ShatteredSpace.esm',
      'SFBGS006.esm', 'SFBGS007.esm', 'SFBGS003.esm', 'SFBGS008.esm', 'SFBGS004.esm', 'SFBGS00D.esm', 'SFBGS047.esm',
      'SFBGS050.esm', 'BlueprintShips-SFBGS050.esm',
    ]],
    ['no release', undefined, []],
    ['a release the table holds no row for', 'SomeRelease', []],
  ])('answers the masters of %s, as Mutagen\'s Implicits.Listings, in the order the game loads them', (_case, release, masters) => {
    expect(loadedWithNoLineOf(release, [])).toEqual(masters);
  });

  it('answers the game\'s masters, then the Creation Club plugins, in that order', () => {
    expect(loadedWithNoLineOf('SkyrimSE', ['ccA.esl', 'ccB.esl']))
      .toEqual(['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm', 'ccA.esl', 'ccB.esl']);
  });
});

describe('creationClubListFile', () => {
  it.each([
    ['Fallout4', 'Fallout4.ccc'],
    ['SkyrimSE', 'Skyrim.ccc'],
    ['Starfield', 'Starfield.ccc'],
  ])('names %s\'s Creation Club list in the game folder, %s', (release, file) => {
    expect(creationClubListFile('/game', release)).toBe(join('/game', file));
  });

  it.each([['a release with no Creation Club', 'SomeRelease'], ['no release', undefined]])('names none for %s', (_case, release) => {
    expect(creationClubListFile('/game', release)).toBeUndefined();
  });
});

describe('pluginCompanionRule', () => {
  const rule = (release: string): PluginCompanionRule => {
    const found = pluginCompanionRule(release);
    if (found === undefined) throw new Error(`no rule for ${release}`);
    return found;
  };

  it.each([
    ['Fallout4', 'Foo.esp', 'Foo.ba2', true],
    ['Fallout4', 'Foo.esp', 'FOO - Main.BA2', true],
    ['Fallout4', 'Foo.esp', 'Foo - Bar - Main.ba2', false],
    ['Fallout4', 'Foo - Bar.esp', 'Foo - Bar - Main.ba2', true],
    ['Fallout4', 'Foo.esp', 'Foo - Main.bsa', false],
    ['SkyrimSE', 'Foo.esp', 'Foo - Main.bsa', true],
    ['Fallout4', 'Foo.esp', 'Foobar.ba2', false],
    ['Starfield', 'Foo.esp', 'Foo - Main.ba2', true],
  ])('in %s takes as the archive of %s, its own name or its name cut at the last " - " with the release\'s extension, %s: %s', (release, plugin, file, taken) => {
    expect(rule(release).inRoot(plugin, file)).toBe(taken);
  });

  it.each([
    ['FOO - Main.BA2', true],
    ['Foo.ini', false],
    ['Foo - Main.bsa', false],
  ])('takes as the archives the game loads with a plugin the archives it takes in the root, never the ini: %s is %s', (file, taken) => {
    expect(rule('Fallout4').isArchiveOf('Foo.esp', file)).toBe(taken);
  });

  it.each([
    ['STRINGS/Bar_xx.ILSTRINGS', true],
    ['strings/Bar_en.txt', false],
    ['Bar_en.STRINGS', false],
    ['Nested/strings/Bar_en.STRINGS', false],
    ['strings/Nested/Bar_en.STRINGS', false],
  ])('takes %s for a strings file of any plugin, in any language, only in the strings folder at the root: %s', (relativePath, taken) => {
    expect(rule('Fallout4').isStringsFile(relativePath)).toBe(taken);
  });

  it.each([
    ['Unnamed - Main.BA2', true],
    ['Unnamed - Main.bsa', false],
    ['Nested/Unnamed - Main.ba2', false],
  ])('takes %s for an archive the release loads, of any plugin or of none, only at the root: %s', (relativePath, taken) => {
    expect(rule('Fallout4').isArchive(relativePath)).toBe(taken);
  });

  it('takes the ini of the plugin\'s name', () => {
    expect(rule('Fallout4').inRoot('Foo.esp', 'foo.INI')).toBe(true);
  });

  it.each([
    ['Fallout4', 'FOO_en.STRINGS', true],
    ['Fallout4', 'Foo_en.ilstrings', true],
    ['Fallout4', 'Foo_English.STRINGS', false],
    ['SkyrimSE', 'Foo_English.STRINGS', true],
    ['Fallout4', 'Foo_Bar_en.STRINGS', false],
    ['Starfield', 'Foo_en.STRINGS', true],
  ])('in %s takes %s for a strings file of Foo.esp, in each language of the release, whatever its case: %s', (release, file, taken) => {
    expect(rule(release).inStringsFolder('Foo.esp', file)).toBe(taken);
  });

  it.each([['no release', undefined], ['a release the table holds no row for', 'SomeRelease']])('answers undefined for %s', (_case, release) => {
    expect(pluginCompanionRule(release)).toBeUndefined();
  });
});

describe('archiveListsOf', () => {
  it('lists Fallout 4\'s archives under the four keys xEdit reads, in the order the game loads them', () => {
    expect(archiveListsOf('Fallout4')?.keys)
      .toEqual(['sResourceIndexFileList', 'sResourceStartUpArchiveList', 'sResourceArchiveList', 'sResourceArchiveList2']);
  });

  it.each([
    ['Fallout4', 'Fallout4'], ['SkyrimSE', 'Skyrim Special Edition'], ['SkyrimVR', 'Skyrim VR'],
  ])('keeps %s\'s INIs in the My Games folder %s', (release, folder) => {
    expect(archiveListsOf(release)?.myGamesFolder).toBe(folder);
  });

  it.each([['no release', undefined], ['a release the table holds no row for', 'SomeRelease']])('answers none for %s', (_case, release) => {
    expect(archiveListsOf(release)).toBeUndefined();
  });
});

describe('nexusDomainsForGame', () => {
  it.each([
    ['Fallout 4', ['fallout4']],
    ['Fallout 4 VR', ['fallout4']],
    ['Skyrim Special Edition', ['skyrimspecialedition', 'skyrim']],
    ['Skyrim VR', ['skyrimspecialedition', 'skyrim']],
    ['Starfield', ['starfield']],
    ['Morrowind', []],
  ])('answers the domains MO2 asks Nexus about a file of %s, each once', (game, domains) => {
    expect(nexusDomainsForGame(game)).toEqual(domains);
  });
});

describe('shortNameForNexusDomain', () => {
  it.each([['fallout4', 'Fallout4'], ['skyrim', 'Skyrim'], ['oblivion', undefined]])('names the game on %s as %s', (domain, name) => {
    expect(shortNameForNexusDomain(domain)).toBe(name);
  });
});
