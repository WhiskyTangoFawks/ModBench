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

    [SmokeTheory("unpack from the installed game's own texture archives")]
    [MemberData(nameof(InstalledGames))]
    public void EveryTextureOfAnInstalledGamesArchives_IsAskedFor_AndNoArchiveIsUnreadable_AndACubemapIsRefused(GameRelease release)
    {
        Assert.True(new GameLocator().TryGetDataDirectory(release, out var data));

        var refusals = Directory.EnumerateFiles(data.Path, "*Textures*.ba2").Select(archive =>
        {
            var textures = Mutagen.Bethesda.Archives.Archive.CreateReader(release, archive).Files.Select(file => file.Path.Replace('\\', '/')).ToList();
            return ArchiveUnpacker.Unpack(release, archive, textures, out _);
        }).ToList();

        Assert.DoesNotContain(refusals, refusal => refusal?.Reason == ArchiveRefusal.ArchiveUnreadable);
        Assert.Contains(refusals, refusal => refusal?.Reason == ArchiveRefusal.CubemapNotUnpackable);
    }
}
