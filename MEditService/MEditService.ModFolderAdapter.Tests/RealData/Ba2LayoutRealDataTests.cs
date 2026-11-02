using System.Buffers.Binary;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Installs;

namespace MEditService.ModFolderAdapter.Tests.RealData;

public sealed class Ba2LayoutRealDataTests
{
    private const int SampledEntries = 25;

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
    public void TheArchivesOfAnInstalledGame_UnpackUnlessTheirVersionIsNotShownToBeReadCorrectly_AndACubemapIsRefused(GameRelease release)
    {
        Assert.True(new GameLocator().TryGetDataDirectory(release, out var data));

        var results = Directory.EnumerateFiles(data.Path, "*.ba2").Select(archive =>
        {
            var entries = Mutagen.Bethesda.Archives.Archive.CreateReader(release, archive).Files.Select(file => file.Path.Replace('\\', '/')).ToList();
            var asked = entries.Where(path => path.Contains("cubemap", StringComparison.OrdinalIgnoreCase)).Concat(entries.Take(SampledEntries)).Distinct().ToList();
            return (Archive: archive, Refusal: ArchiveUnpacker.Unpack(release, archive, asked, out _));
        }).ToList();

        var unreadableOfACheckedVersion = results.Where(result => result.Refusal?.Reason == ArchiveRefusal.ArchiveUnreadable && IsChecked(result.Archive));
        Assert.Empty(unreadableOfACheckedVersion);
        Assert.Contains(results, result => result.Refusal?.Reason == ArchiveRefusal.CubemapNotUnpackable);
    }

    private static bool IsChecked(string archive)
    {
        var header = new byte[12];
        using (var file = File.OpenRead(archive)) file.ReadExactly(header);
        var version = BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(4));
        return version == 1 || (version is 2 or 8 && !header.AsSpan(8, 4).SequenceEqual("DX10"u8));
    }
}
