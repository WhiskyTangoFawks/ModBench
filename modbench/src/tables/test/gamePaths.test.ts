import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  creationClubListFile, dataFolderFile, gameMastersOf, gameReleaseForGame, nexusSlugFor, gamePathInfoForRelease, pluginCompanionRule, type PluginCompanionRule,
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

describe('nexusSlugFor', () => {
  it('maps a release to its Nexus slug', () => {
    expect(nexusSlugFor('Fallout4', 'Fallout 4')).toBe('fallout4');
    expect(nexusSlugFor('SkyrimSE', 'Skyrim Special Edition')).toBe('skyrimspecialedition');
    expect(nexusSlugFor('Fallout3', 'Fallout 3')).toBe('fallout3');
    expect(nexusSlugFor('FalloutNV', 'Fallout New Vegas')).toBe('newvegas');
    expect(nexusSlugFor('SkyrimLE', 'Skyrim')).toBe('skyrim');
    expect(nexusSlugFor('EnderalLE', 'Enderal')).toBe('enderal');
    expect(nexusSlugFor('Oblivion', 'Oblivion')).toBe('oblivion');
  });

  it('maps VR variants to their non-VR Nexus domain', () => {
    expect(nexusSlugFor('Fallout4VR', 'Fallout 4 VR')).toBe('fallout4');
    expect(nexusSlugFor('SkyrimVR', 'Skyrim VR')).toBe('skyrimspecialedition');
  });

  it('keys on the release, not on the name as the instance\'s settings spell it', () => {
    expect(nexusSlugFor('SkyrimSE', 'Fallout 4')).toBe('skyrimspecialedition');
  });

  it('falls back to a lowercased, space-stripped name for a game with no release, which for Morrowind happens to match Nexus\'s own slug', () => {
    expect(nexusSlugFor(undefined, 'Morrowind')).toBe('morrowind');
    expect(nexusSlugFor(undefined, 'Some Game')).toBe('somegame');
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

describe('dataFolderFile', () => {
  it('names a file at the root of the Data folder of a game folder found', () => {
    const found = { kind: 'found', root: '/game', dataFolder: '/game/Data' } as const;
    expect(dataFolderFile(found, 'Fallout4.esm')).toBe('/game/Data/Fallout4.esm');
  });

  it('names the same file when the Data folder setting ends in a separator', () => {
    const found = { kind: 'found', root: '/game', dataFolder: '/game/Data/' } as const;
    expect(dataFolderFile(found, 'Fallout4.esm')).toBe('/game/Data/Fallout4.esm');
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
