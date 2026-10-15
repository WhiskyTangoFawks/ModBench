import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  archiveListsOf, ba2VersionsOf, creationClubListFile, dataFolderFile, gameMastersOf, gameReleaseForGame, nexusDomainForMetaGame, gamePathInfoForRelease, pluginCompanionRule, SCRIPT_EXTENDER_FOLDERS, type PluginCompanionRule,
} from '../gamePaths';

describe('gameReleaseForGame', () => {
  it('maps a game\'s name, as an instance\'s settings spell it, to Mutagen\'s release name', () => {
    expect(gameReleaseForGame('Fallout 4')).toBe('Fallout4');
    expect(gameReleaseForGame('Fallout 4 VR')).toBe('Fallout4VR');
    expect(gameReleaseForGame('Fallout 3')).toBe('Fallout3');
    expect(gameReleaseForGame('Fallout New Vegas')).toBe('FalloutNV');
    expect(gameReleaseForGame('Skyrim Special Edition')).toBe('SkyrimSE');
    expect(gameReleaseForGame('Skyrim VR')).toBe('SkyrimVR');
    expect(gameReleaseForGame('Enderal')).toBe('EnderalLE');
    expect(gameReleaseForGame('Oblivion')).toBe('Oblivion');
    expect(gameReleaseForGame('Starfield')).toBe('Starfield');
  });

  it('maps MO2\'s bare "Skyrim" to the Legendary Edition, not to "Skyrim", the one name whose vocabularies disagree beyond spacing, so a whitespace strip would answer a release that does not exist', () => {
    expect(gameReleaseForGame('Skyrim')).toBe('SkyrimLE');
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
    [undefined, undefined],
  ])('answers the BA2 versions %s\'s archives pack as, and none for a release whose archives mEdit is not known to write so the game loads them', (release, variants) => {
    expect(ba2VersionsOf(release)).toEqual(variants);
  });
});

describe('nexusDomainForMetaGame', () => {
  it.each([
    ['Fallout 4', 'fallout4'],
    ['SkyrimSE', 'skyrimspecialedition'],
    ['Skyrim Special Edition', 'skyrimspecialedition'],
    ['Fallout New Vegas', 'newvegas'],
    ['Fallout 4 VR', 'fallout4'],
    ['SkyrimVR', 'skyrimspecialedition'],
  ])('maps %s, as a mod\'s or a download\'s metadata spells it, to its Nexus domain', (game, domain) => {
    expect(nexusDomainForMetaGame(game)).toBe(domain);
  });

  it.each(['EnderalSE', 'Enderal Special Edition', 'Morrowind', 'Some Game'])('gives %s no domain, never a guess from its name', (game) => {
    expect(nexusDomainForMetaGame(game)).toBeUndefined();
  });
});

describe('gamePathInfoForRelease', () => {
  it('answers Fallout 4\'s Steam install facts', () => {
    expect(gamePathInfoForRelease('Fallout4')).toMatchObject({
      gameName: 'Fallout 4',
      nexusSlug: 'fallout4',
      steamAppId: '377160',
      steamFolderName: 'Fallout 4',
    });
  });

  it('answers no Steam facts for a release the table only knows the Nexus slug for, the autodetector\'s signal to give up rather than guess a folder', () => {
    const info = gamePathInfoForRelease('SkyrimSE');
    expect(info).toMatchObject({ gameName: 'Skyrim Special Edition', nexusSlug: 'skyrimspecialedition' });
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

describe('dataFolderFile', () => {
  it('names a file at the root of the Data folder of a game folder found', () => {
    const found = { kind: 'found', root: '/game', dataFolder: '/game/Data' } as const;
    expect(dataFolderFile(found, 'Fallout4.esm')).toBe(join('/game', 'Data', 'Fallout4.esm'));
  });

  it('names the same file when the Data folder setting ends in a separator', () => {
    const found = { kind: 'found', root: '/game', dataFolder: '/game/Data/' } as const;
    expect(dataFolderFile(found, 'Fallout4.esm')).toBe(join('/game', 'Data', 'Fallout4.esm'));
  });

  it('names nothing while the game folder is not found', () => {
    const notFound = { kind: 'notFound', looked: [], setting: 'modbench.mods.gameDirectory' } as const;
    expect(dataFolderFile(notFound, 'Fallout4.esm')).toBeUndefined();
  });
});

describe('gameMastersOf', () => {
  it('answers the game\'s masters, as Mutagen\'s Implicits.Listings, in the order the game loads them', () => {
    expect(gameMastersOf('Fallout4')).toEqual([
      'Fallout4.esm', 'DLCRobot.esm', 'DLCworkshop01.esm', 'DLCCoast.esm', 'DLCworkshop02.esm', 'DLCworkshop03.esm',
      'DLCNukaWorld.esm',
    ]);
    expect(gameMastersOf('SkyrimSE')).toEqual(['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm']);
    expect(gameMastersOf('Oblivion')).toEqual(['Oblivion.esm']);
    expect(gameMastersOf('Starfield')).toEqual([
      'Starfield.esm', 'Constellation.esm', 'OldMars.esm', 'BlueprintShips-Starfield.esm', 'ShatteredSpace.esm',
      'SFBGS006.esm', 'SFBGS007.esm', 'SFBGS003.esm', 'SFBGS008.esm', 'SFBGS004.esm', 'SFBGS00D.esm', 'SFBGS047.esm',
      'SFBGS050.esm', 'BlueprintShips-SFBGS050.esm',
    ]);
  });

  it('answers none for a release the table holds no row for', () => {
    expect(gameMastersOf(undefined)).toEqual([]);
    expect(gameMastersOf('SomeRelease')).toEqual([]);
  });
});

describe('creationClubListFile', () => {
  it('names the release\'s Creation Club list in the game folder', () => {
    expect(creationClubListFile('/game', 'Fallout4')).toBe(join('/game', 'Fallout4.ccc'));
    expect(creationClubListFile('/game', 'SkyrimSE')).toBe(join('/game', 'Skyrim.ccc'));
    expect(creationClubListFile('/game', 'Starfield')).toBe(join('/game', 'Starfield.ccc'));
  });

  it('names none for a release with no Creation Club, or no release', () => {
    expect(creationClubListFile('/game', 'Oblivion')).toBeUndefined();
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

  it('takes the ini of the plugin\'s name for a release that ties one to its plugins', () => {
    expect(rule('Fallout4').inRoot('Foo.esp', 'foo.INI')).toBe(true);
    expect(rule('Oblivion').inRoot('Foo.esp', 'Foo.ini')).toBe(false);
  });

  it('takes the strings of the plugin in each language of the release, whatever their case', () => {
    expect(rule('Fallout4').inStringsFolder('Foo.esp', 'FOO_en.STRINGS')).toBe(true);
    expect(rule('Fallout4').inStringsFolder('Foo.esp', 'Foo_en.ilstrings')).toBe(true);
    expect(rule('Fallout4').inStringsFolder('Foo.esp', 'Foo_English.STRINGS')).toBe(false);
    expect(rule('SkyrimSE').inStringsFolder('Foo.esp', 'Foo_English.STRINGS')).toBe(true);
    expect(rule('Fallout4').inStringsFolder('Foo.esp', 'Foo_Bar_en.STRINGS')).toBe(false);
  });

  it('takes no strings for a release whose plugins carry none', () => {
    expect(rule('Oblivion').inStringsFolder('Foo.esp', 'Foo_en.STRINGS')).toBe(false);
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
    ['Fallout4', 'Fallout4'], ['SkyrimSE', 'Skyrim Special Edition'], ['SkyrimLE', 'Skyrim'], ['SkyrimVR', 'Skyrim VR'], ['FalloutNV', 'FalloutNV'],
  ])('keeps %s\'s INIs in the My Games folder %s', (release, folder) => {
    expect(archiveListsOf(release)?.myGamesFolder).toBe(folder);
  });

  it('answers none for no release, or a release the table holds no row for', () => {
    expect(archiveListsOf(undefined)).toBeUndefined();
    expect(archiveListsOf('SomeRelease')).toBeUndefined();
  });
});
