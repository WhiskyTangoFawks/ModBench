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
    private const int TextureChunkLength = 24;
    private const int Caps2At = 112;
    private const int MiscFlagsAt = 136;
    private const uint CubemapWithAllFaces = 0xFE00;
    private const uint TextureCubeMisc = 0x4;
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
    public void EveryEntryOfTheInstalledGamesArchives_Unpacks_ACubemapWithItsCubeCaps(GameRelease release)
    {
        Assert.True(new GameLocator().TryGetDataDirectory(release, out var data));

        var failures = new List<string>();
        var cubemaps = 0;
        foreach (var archive in Directory.EnumerateFiles(data.Path, "*.ba2"))
        {
            foreach (var batch in EntryPaths(release, archive).Chunk(Batch))
            {
                var refusal = ArchiveUnpacker.Unpack(release, archive, batch, out var files);
                if (refusal is not null) failures.Add($"{archive}: {refusal.Message}");
                foreach (var file in files.Where(file => file.Path.EndsWith(".dds", StringComparison.OrdinalIgnoreCase)))
                {
                    var header = Bytes(file);
                    if (!header.AsSpan(0, 4).SequenceEqual("DDS "u8)) failures.Add($"{archive}: {file.Path} has no DDS header");
                    else if (BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(Caps2At)) == CubemapWithAllFaces) cubemaps++;
                }
            }
        }

        Assert.Empty(failures);
        Assert.True(cubemaps > 0, "an installed game's archives hold cubemaps");
    }

    [InstalledGameSmokeTheory("compare the DDS headers Modbench writes with Mutagen's", GameRelease.Fallout4)]
    [MemberData(nameof(InstalledFallout4))]
    public void TheDdsHeaderOfEveryTextureOfAVersion1Archive_MatchesMutagens_ExceptTheCapsOfASingleMipTextureAndTheCubeFieldsOfACubemapWhichCarryTheCubeFlags(GameRelease release)
    {
        Assert.True(new GameLocator().TryGetDataDirectory(release, out var data));

        var differences = new List<string>();
        var compared = 0;
        foreach (var archive in Directory.EnumerateFiles(data.Path, "*.ba2").Where(IsVersion1Textures))
        {
            var cubemaps = CubemapPaths(archive);
            var mutagen = Archive.CreateReader(release, archive).Files
                .GroupBy(file => file.Path.Replace('\\', '/'), StringComparer.OrdinalIgnoreCase)
                .Where(named => named.Count() == 1)
                .ToDictionary(named => named.Key, named => named.Single(), StringComparer.OrdinalIgnoreCase);
            foreach (var batch in mutagen.Keys.Chunk(Batch))
            {
                Assert.Null(ArchiveUnpacker.Unpack(release, archive, batch, out var files));
                foreach (var file in files)
                {
                    compared++;
                    var difference = Difference(Bytes(file), mutagen[file.Path].GetBytes(), cubemaps.Contains(file.Path));
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

    private static string? Difference(byte[] written, byte[] mutagens, bool isCubemap)
    {
        if (written.Length != mutagens.Length) return $"{written.Length} bytes against Mutagen's {mutagens.Length}";

        var headerLength = written.AsSpan(84, 4).SequenceEqual("DX10"u8) ? ExtendedHeaderLength : MainHeaderLength;
        var (ours, theirs) = (written[..headerLength], mutagens[..headerLength]);
        var mips = BinaryPrimitives.ReadUInt32LittleEndian(written.AsSpan(MipCountAt));
        if (isCubemap && !CarriesTheCubeFlags(written, headerLength)) return "a cubemap without the cube caps and all six faces";
        foreach (var header in new[] { ours, theirs })
        {
            if (mips == 1 || isCubemap) Array.Clear(header, CapsAt, CapsLength);
            if (isCubemap)
            {
                Array.Clear(header, Caps2At, CapsLength);
                if (headerLength == ExtendedHeaderLength) Array.Clear(header, MiscFlagsAt, CapsLength);
            }
            if (BinaryPrimitives.ReadUInt32LittleEndian(written.AsSpan(PixelFormatFlagsAt)) == UncompressedRgb)
            {
                BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(FlagsAt), BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(FlagsAt)) & ~(PitchFlag | LinearSizeFlag));
                Array.Clear(header, PitchOrLinearSizeAt, CapsLength);
            }
        }

        var differing = Enumerable.Range(0, headerLength).Where(at => ours[at] != theirs[at]).ToList();
        return differing.Count == 0
            ? null
            : $"header bytes {string.Join(',', differing)} differ, in a {mips}-mip texture of {FormatOf(written)}";
    }

    private static HashSet<string> CubemapPaths(string archive)
    {
        using var reader = new BinaryReader(File.OpenRead(archive));
        reader.ReadBytes(8);
        var kind = reader.ReadBytes(4);
        var count = reader.ReadUInt32();
        var nameTable = reader.ReadInt64();
        Assert.True(kind.AsSpan().SequenceEqual("DX10"u8));
        var cube = new List<bool>();
        for (var i = 0; i < count; i++)
        {
            reader.ReadBytes(13);
            var chunks = reader.ReadByte();
            reader.ReadBytes(8);
            cube.Add(reader.ReadByte() != 0);
            reader.ReadByte();
            reader.ReadBytes(chunks * TextureChunkLength);
        }

        reader.BaseStream.Position = nameTable;
        return new HashSet<string>(cube.Select(isCube => (isCube, Name: System.Text.Encoding.UTF8.GetString(reader.ReadBytes(reader.ReadUInt16())).Replace('\\', '/')))
            .Where(entry => entry.isCube).Select(entry => entry.Name), StringComparer.OrdinalIgnoreCase);
    }

    private static bool CarriesTheCubeFlags(byte[] written, int headerLength) =>
        BinaryPrimitives.ReadUInt32LittleEndian(written.AsSpan(Caps2At)) == CubemapWithAllFaces
        && (headerLength == MainHeaderLength || BinaryPrimitives.ReadUInt32LittleEndian(written.AsSpan(MiscFlagsAt)) == TextureCubeMisc);

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
}
