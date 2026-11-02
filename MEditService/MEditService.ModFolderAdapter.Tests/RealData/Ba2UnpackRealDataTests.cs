using System.Buffers.Binary;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Archives;
using Mutagen.Bethesda.Installs;

namespace MEditService.ModFolderAdapter.Tests.RealData;

public sealed class Ba2UnpackRealDataTests
{
    private const int Batch = 1000;
    private const int MainHeaderLength = 128;
    private const int ExtendedHeaderLength = 148;
    private const int MipCountAt = 28;
    private const int CapsAt = 108;
    private const int CapsLength = 4;
    private const int FlagsAt = 8;
    private const int PitchOrLinearSizeAt = 20;
    private const int PixelFormatFlagsAt = 80;
    private const uint UncompressedRgb = 0x41;
    private const uint PitchFlag = 0x8;
    private const uint LinearSizeFlag = 0x80000;

    public static TheoryData<GameRelease> InstalledGames()
    {
        TheoryData<GameRelease> rows = [];
        foreach (var release in new[] { GameRelease.Fallout4, GameRelease.Starfield })
        {
            if (InstalledGameSmokeTheoryAttribute.IsInstalled(release)) rows.Add(release);
        }
        return rows;
    }

    public static TheoryData<GameRelease> InstalledFallout4() =>
        InstalledGameSmokeTheoryAttribute.IsInstalled(GameRelease.Fallout4) ? [GameRelease.Fallout4] : [];

    [InstalledGameSmokeTheory("unpack from the installed game's own archives", GameRelease.Fallout4, GameRelease.Starfield)]
    [MemberData(nameof(InstalledGames))]
    public void EveryEntryOfTheInstalledGamesArchives_Unpacks_ExceptACubemap(GameRelease release)
    {
        Assert.True(new GameLocator().TryGetDataDirectory(release, out var data));

        var failures = new List<string>();
        var cubemaps = 0;
        foreach (var archive in Directory.EnumerateFiles(data.Path, "*.ba2"))
        {
            foreach (var batch in EntryPaths(release, archive).Chunk(Batch))
            {
                var (refusal, files, skipped) = UnpackSkippingCubemaps(release, archive, batch);
                cubemaps += skipped;
                if (refusal is not null) failures.Add($"{archive}: {refusal.Message}");
                else if (files.Any(file => file.Path.EndsWith(".dds", StringComparison.OrdinalIgnoreCase) && !StartsWithDds(file))) failures.Add($"{archive}: a texture has no DDS header");
            }
        }

        Assert.Empty(failures);
        Assert.True(cubemaps > 0, "an installed game's archives hold cubemaps");
    }

    [InstalledGameSmokeTheory("compare the DDS headers Modbench writes with Mutagen's", GameRelease.Fallout4)]
    [MemberData(nameof(InstalledFallout4))]
    public void TheDdsHeaderOfEveryTextureOfAVersion1Archive_MatchesMutagens_ExceptTheCapsOfASingleMipTexture(GameRelease release)
    {
        Assert.True(new GameLocator().TryGetDataDirectory(release, out var data));

        var differences = new List<string>();
        var compared = 0;
        foreach (var archive in Directory.EnumerateFiles(data.Path, "*.ba2").Where(IsVersion1Textures))
        {
            var mutagen = Archive.CreateReader(release, archive).Files
                .GroupBy(file => file.Path.Replace('\\', '/'), StringComparer.OrdinalIgnoreCase)
                .Where(named => named.Count() == 1)
                .ToDictionary(named => named.Key, named => named.Single(), StringComparer.OrdinalIgnoreCase);
            foreach (var batch in mutagen.Keys.Chunk(Batch))
            {
                var (refusal, files, _) = UnpackSkippingCubemaps(release, archive, batch);
                Assert.Null(refusal);
                foreach (var file in files)
                {
                    compared++;
                    var difference = Difference(Bytes(file), mutagen[file.Path].GetBytes());
                    if (difference is not null) differences.Add($"{archive}: {file.Path}: {difference}");
                }
            }
        }

        Assert.True(compared > 0, "an installed game's archives hold version 1 textures");
        var kinds = differences.GroupBy(difference => difference[(difference.LastIndexOf(": ", StringComparison.Ordinal) + 2)..]);
        Assert.True(differences.Count == 0, $"{differences.Count} entries differ; by kind:\n{string.Join('\n', kinds.Select(kind => $"{kind.Count()} x {kind.Key}, e.g. {kind.First()}"))}");
    }

    private static IEnumerable<string> EntryPaths(GameRelease release, string archive) =>
        Archive.CreateReader(release, archive).Files.Select(file => file.Path.Replace('\\', '/'));

    private static (ArchiveStepRefusal? Refusal, List<ArchiveFile> Files, int Cubemaps) UnpackSkippingCubemaps(GameRelease release, string archive, string[] paths)
    {
        var refusal = ArchiveUnpacker.Unpack(release, archive, paths, out var unpacked);
        if (refusal?.Reason != ArchiveRefusal.CubemapNotUnpackable) return (refusal, [.. unpacked], 0);

        List<ArchiveFile> files = [];
        var cubemaps = 0;
        foreach (var path in paths)
        {
            var alone = ArchiveUnpacker.Unpack(release, archive, [path], out var one);
            if (alone is null) files.AddRange(one);
            else if (alone.Reason == ArchiveRefusal.CubemapNotUnpackable) cubemaps++;
            else return (alone, files, cubemaps);
        }
        return (null, files, cubemaps);
    }

    private static string? Difference(byte[] written, byte[] mutagens)
    {
        if (written.Length != mutagens.Length) return $"{written.Length} bytes against Mutagen's {mutagens.Length}";

        var headerLength = written.AsSpan(84, 4).SequenceEqual("DX10"u8) ? ExtendedHeaderLength : MainHeaderLength;
        var (ours, theirs) = (written[..headerLength], mutagens[..headerLength]);
        var mips = BinaryPrimitives.ReadUInt32LittleEndian(written.AsSpan(MipCountAt));
        foreach (var header in new[] { ours, theirs })
        {
            if (mips == 1) Array.Clear(header, CapsAt, CapsLength);
            if (BinaryPrimitives.ReadUInt32LittleEndian(written.AsSpan(PixelFormatFlagsAt)) == UncompressedRgb)
            {
                BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(FlagsAt), BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(FlagsAt)) & ~(PitchFlag | LinearSizeFlag));
                Array.Clear(header, PitchOrLinearSizeAt, 4);
            }
        }

        var differing = Enumerable.Range(0, headerLength).Where(at => ours[at] != theirs[at]).ToList();
        return differing.Count == 0
            ? null
            : $"header bytes {string.Join(',', differing)} differ, in a {mips}-mip texture of {FormatOf(written)}";
    }

    private static string FormatOf(byte[] header) =>
        header.AsSpan(84, 4).SequenceEqual("DX10"u8)
            ? $"DXGI {BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(MainHeaderLength))}"
            : $"pixel format {BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(80)):X}/{System.Text.Encoding.ASCII.GetString(header, 84, 4)}/{BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(88))}";

    private static bool IsVersion1Textures(string archive)
    {
        var header = new byte[12];
        using (var file = File.OpenRead(archive)) file.ReadExactly(header);
        return BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(4)) == 1 && header.AsSpan(8, 4).SequenceEqual("DX10"u8);
    }

    private static byte[] Bytes(ArchiveFile file)
    {
        using var content = file.Open();
        using var whole = new MemoryStream();
        content.CopyTo(whole);
        return whole.ToArray();
    }

    private static bool StartsWithDds(ArchiveFile file)
    {
        using var content = file.Open();
        Span<byte> magic = stackalloc byte[4];
        content.ReadExactly(magic);
        return magic.SequenceEqual("DDS "u8);
    }
}
