using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Installs;

namespace MEditService.ModFolderAdapter.Tests.RealData;

public sealed class Ba2CubemapsRealDataTests
{
    private const long SmallArchive = 150_000_000;
    private const int SampleOfALargeArchive = 25;

    public static TheoryData<GameRelease> InstalledGames()
    {
        TheoryData<GameRelease> rows = [];
        foreach (var release in new[] { GameRelease.Fallout4, GameRelease.Starfield })
        {
            if (new GameLocator().TryGetDataDirectory(release, out _)) rows.Add(release);
        }
        return rows;
    }

    [SmokeTheory("unpack from the installed game's own archives")]
    [MemberData(nameof(InstalledGames))]
    public void TheArchivesOfAnInstalledGame_AreAskedForTheirEntries_NoneThrows_AndACubemapIsRefused(GameRelease release)
    {
        Assert.True(new GameLocator().TryGetDataDirectory(release, out var data));

        var refusals = Directory.EnumerateFiles(data.Path, "*.ba2").Select(archive =>
        {
            var entries = Mutagen.Bethesda.Archives.Archive.CreateReader(release, archive).Files.Select(file => file.Path.Replace('\\', '/')).ToList();
            var cubemapNamed = entries.Where(path => path.Contains("cubemap", StringComparison.OrdinalIgnoreCase));
            var asked = new FileInfo(archive).Length < SmallArchive ? entries : [.. cubemapNamed.Concat(entries.Take(SampleOfALargeArchive)).Distinct()];
            return ArchiveUnpacker.Unpack(release, archive, asked, out _);
        }).OfType<ArchiveStepRefusal>().ToList();

        Assert.Contains(refusals, refusal => refusal.Reason == ArchiveRefusal.CubemapNotUnpackable);
    }
}
