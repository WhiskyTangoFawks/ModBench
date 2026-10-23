import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  archiveListsOf, ba2VersionsOf, creationClubListFile, gameReleaseForGame, loadedWithNoLineOf, nexusDomainsForGame, nexusDomainForMetaGame, gamePathInfoForRelease, pluginCompanionRule, SCRIPT_EXTENDER_FOLDERS, type PluginCompanionRule,
} from '../gamePaths';

describe('gameReleaseForGame', () => {
  it('maps a game\'s name, as an instance\'s settings spell it, to Mutagen\'s release name', () => {
    expect(gameReleaseForGame('Fallout 4')).toBe('Fallout4');
    expect(gameReleaseForGame('Fallout 4 VR')).toBe('Fallout4VR');
    expect(gameReleaseForGame('Skyrim Special Edition')).toBe('SkyrimSE');
    expect(gameReleaseForGame('Skyrim VR')).toBe('SkyrimVR');
    expect(gameReleaseForGame('Starfield')).toBe('Starfield');
  });

  it.each(['Skyrim', 'Enderal', 'Oblivion', 'Fallout 3', 'Fallout New Vegas'])('answers undefined for %s, a game whose plugins.txt Modbench does not write', (game) => {
    expect(gameReleaseForGame(game)).toBeUndefined();
  });

  it('answers undefined for a game Mutagen has no release for, as every value must be a name the backend\'s Enum.TryParse<GameRelease> accepts', () => {
    expect(gameReleaseForGame('Morrowind')).toBeUndefined();
  });

  it('answers undefined for an unknown game rather than guessing one', () => {
    expect(gameReleaseForGame('Some Game')).toBeUndefined();
    expect(gameReleaseForGame('')).toBeUndefined();
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
    ['Fallout4', '377160', 'Fallout 4'],
    ['SkyrimSE', '489830', 'Skyrim Special Edition'],
    ['Starfield', '1716740', 'Starfield'],
  ])('answers %s\'s Steam install facts', (release, steamAppId, steamFolderName) => {
    expect(gamePathInfoForRelease(release)).toMatchObject({ steamAppId, steamFolderName });
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
  it('answers the game\'s masters, as Mutagen\'s Implicits.Listings, in the order the game loads them', () => {
    expect(loadedWithNoLineOf('Fallout4', [])).toEqual([
      'Fallout4.esm', 'DLCRobot.esm', 'DLCworkshop01.esm', 'DLCCoast.esm', 'DLCworkshop02.esm', 'DLCworkshop03.esm',
      'DLCNukaWorld.esm',
    ]);
    expect(loadedWithNoLineOf('SkyrimSE', [])).toEqual(['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm']);
    expect(loadedWithNoLineOf('Starfield', [])).toEqual([
      'Starfield.esm', 'Constellation.esm', 'OldMars.esm', 'BlueprintShips-Starfield.esm', 'ShatteredSpace.esm',
      'SFBGS006.esm', 'SFBGS007.esm', 'SFBGS003.esm', 'SFBGS008.esm', 'SFBGS004.esm', 'SFBGS00D.esm', 'SFBGS047.esm',
      'SFBGS050.esm', 'BlueprintShips-SFBGS050.esm',
    ]);
  });

  it('answers no master for a release the table holds no row for', () => {
    expect(loadedWithNoLineOf(undefined, [])).toEqual([]);
    expect(loadedWithNoLineOf('SomeRelease', [])).toEqual([]);
  });

  it('answers the game\'s masters, then the Creation Club plugins, in that order', () => {
    expect(loadedWithNoLineOf('SkyrimSE', ['ccA.esl', 'ccB.esl'])).toEqual([...loadedWithNoLineOf('SkyrimSE', []), 'ccA.esl', 'ccB.esl']);
  });
});

describe('creationClubListFile', () => {
  it('names the release\'s Creation Club list in the game folder', () => {
    expect(creationClubListFile('/game', 'Fallout4')).toBe(join('/game', 'Fallout4.ccc'));
    expect(creationClubListFile('/game', 'SkyrimSE')).toBe(join('/game', 'Skyrim.ccc'));
    expect(creationClubListFile('/game', 'Starfield')).toBe(join('/game', 'Starfield.ccc'));
  });

  it('names none for a release with no Creation Club, or no release', () => {
    expect(creationClubListFile('/game', 'SomeRelease')).toBeUndefined();
    expect(creationClubListFile('/game', undefined)).toBeUndefined();
  });
});

describe('pluginCompanionRule', () => {
  const rule = (release: string): PluginCompanionRule => {
    const found = pluginCompanionRule(release);
    if (found === undefined) throw new Error(`no rule for ${release}`);
    return found;
  };

  it('takes the archive of a plugin: its own name, or its name cut at the last " - ", with the release\'s extension', () => {
    expect(rule('Fallout4').inRoot('Foo.esp', 'Foo.ba2')).toBe(true);
    expect(rule('Fallout4').inRoot('Foo.esp', 'FOO - Main.BA2')).toBe(true);
    expect(rule('Fallout4').inRoot('Foo.esp', 'Foo - Bar - Main.ba2')).toBe(false);
    expect(rule('Fallout4').inRoot('Foo - Bar.esp', 'Foo - Bar - Main.ba2')).toBe(true);
    expect(rule('Fallout4').inRoot('Foo.esp', 'Foo - Main.bsa')).toBe(false);
    expect(rule('SkyrimSE').inRoot('Foo.esp', 'Foo - Main.bsa')).toBe(true);
    expect(rule('Fallout4').inRoot('Foo.esp', 'Foobar.ba2')).toBe(false);
    expect(rule('Starfield').inRoot('Foo.esp', 'Foo - Main.ba2')).toBe(true);
    expect(rule('Starfield').inStringsFolder('Foo.esp', 'Foo_en.STRINGS')).toBe(true);
  });

  it('takes as the archives the game loads with a plugin the archives it takes in the root, never the ini', () => {
    expect(rule('Fallout4').isArchiveOf('Foo.esp', 'FOO - Main.BA2')).toBe(true);
    expect(rule('Fallout4').isArchiveOf('Foo.esp', 'Foo.ini')).toBe(false);
    expect(rule('Fallout4').isArchiveOf('Foo.esp', 'Foo - Main.bsa')).toBe(false);
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

  it('takes the strings of the plugin in each language of the release, whatever their case', () => {
    expect(rule('Fallout4').inStringsFolder('Foo.esp', 'FOO_en.STRINGS')).toBe(true);
    expect(rule('Fallout4').inStringsFolder('Foo.esp', 'Foo_en.ilstrings')).toBe(true);
    expect(rule('Fallout4').inStringsFolder('Foo.esp', 'Foo_English.STRINGS')).toBe(false);
    expect(rule('SkyrimSE').inStringsFolder('Foo.esp', 'Foo_English.STRINGS')).toBe(true);
    expect(rule('Fallout4').inStringsFolder('Foo.esp', 'Foo_Bar_en.STRINGS')).toBe(false);
  });

  it('answers undefined for no release, or a release the table holds no row for', () => {
    expect(pluginCompanionRule(undefined)).toBeUndefined();
    expect(pluginCompanionRule('SomeRelease')).toBeUndefined();
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

  it('answers none for no release, or a release the table holds no row for', () => {
    expect(archiveListsOf(undefined)).toBeUndefined();
    expect(archiveListsOf('SomeRelease')).toBeUndefined();
  });
});

describe('nexusDomainsForGame', () => {
  it.each([
    ['Fallout 4', ['fallout4']],
    ['Fallout 4 VR', ['fallout4']],
    ['Skyrim VR', ['skyrimspecialedition']],
    ['Starfield', ['starfield']],
    ['Morrowind', []],
  ])('answers the domains MO2 asks Nexus about a file of %s, each once', (game, domains) => {
    expect(nexusDomainsForGame(game)).toEqual(domains);
  });
});
