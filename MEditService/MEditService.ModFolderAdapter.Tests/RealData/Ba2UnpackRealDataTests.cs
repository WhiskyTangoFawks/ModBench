using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Installs;

namespace MEditService.ModFolderAdapter.Tests.RealData;

public sealed class Ba2UnpackRealDataTests
{
    private const int Batch = 1000;

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
    public void EveryEntryOfTheInstalledGamesArchives_Unpacks_ExceptACubemap(GameRelease release)
    {
        Assert.True(new GameLocator().TryGetDataDirectory(release, out var data));

        var failures = new List<string>();
        var cubemaps = 0;
        foreach (var archive in Directory.EnumerateFiles(data.Path, "*.ba2"))
        {
            var entries = Mutagen.Bethesda.Archives.Archive.CreateReader(release, archive).Files.Select(file => file.Path.Replace('\\', '/')).ToList();
            foreach (var batch in entries.Chunk(Batch))
            {
                var refusal = ArchiveUnpacker.Unpack(release, archive, batch, out var unpacked);
                if (refusal?.Reason == ArchiveRefusal.CubemapNotUnpackable)
                {
                    var eachAlone = batch.Select(path => (Path: path, Refusal: ArchiveUnpacker.Unpack(release, archive, [path], out _))).ToList();
                    cubemaps += eachAlone.Count(one => one.Refusal?.Reason == ArchiveRefusal.CubemapNotUnpackable);
                    refusal = eachAlone.Select(one => one.Refusal).FirstOrDefault(one => one is not null && one.Reason != ArchiveRefusal.CubemapNotUnpackable);
                    unpacked = [];
                }

                if (refusal is not null) failures.Add($"{archive}: {refusal.Message}");
                else if (unpacked.Any(file => file.Path.EndsWith(".dds", StringComparison.OrdinalIgnoreCase) && !StartsWithDds(file))) failures.Add($"{archive}: a texture has no DDS header");
            }
        }

        Assert.Empty(failures);
        Assert.True(cubemaps > 0, "an installed game's archives hold cubemaps");
    }

    private static bool StartsWithDds(ArchiveFile file)
    {
        using var content = file.Open();
        Span<byte> magic = stackalloc byte[4];
        content.ReadExactly(magic);
        return magic.SequenceEqual("DDS "u8);
    }
}
