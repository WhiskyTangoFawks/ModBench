using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Installs;

namespace MEditService.ModFolderAdapter.Tests.RealData;

public sealed class Ba2CubemapsRealDataTests
{
    public static TheoryData<GameRelease> InstalledGames()
    {
        TheoryData<GameRelease> rows = [];
        foreach (var release in new[] { GameRelease.Fallout4, GameRelease.Starfield })
        {
            if (new GameLocator().TryGetDataDirectory(release, out _)) rows.Add(release);
        }
        return rows;
    }

    [SmokeTheory("scan the installed game's texture archives for cubemaps")]
    [MemberData(nameof(InstalledGames))]
    public void TheTextureArchivesOfAnInstalledGame_AreScannedWithoutThrowing_AndHoldACubemap(GameRelease release)
    {
        Assert.True(new GameLocator().TryGetDataDirectory(release, out var data));

        var cubemaps = Directory.EnumerateFiles(data.Path, "*Textures*.ba2").SelectMany(Ba2Cubemaps.In).ToList();

        Assert.NotEmpty(cubemaps);
    }
}
