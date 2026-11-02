using System.Buffers.Binary;
using System.Text;
using K4os.Compression.LZ4;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.ModFolderAdapter.Tests;

public sealed class ArchiveUnpackerTests : IDisposable
{
    private const string Meshes = "Meshes/Actors/A.nif";
    private const string Scripts = "scripts/a.pex";
    private const int HeaderLengthOfVersion3 = 36;
    private const int GeneralEntryAt = 24;
    private const int GeneralEntryLength = 36;
    private const int RecordedSizeAt = 28;
    private const uint Lz4Compression = 3;

    private static readonly byte[] Mesh = Encoding.ASCII.GetBytes(new string('n', 4000));
    private static readonly byte[] Script = Encoding.ASCII.GetBytes("Scriptname A");

    private readonly ScratchDirectory _scratch = new("archive-unpacker-");
    private readonly Dictionary<string, Func<Stream>> _assets = [];

    public void Dispose() => _scratch.Dispose();

    private string Packed(IArchiveVariant variant, params string[] files)
    {
        var archive = Path.Combine(_scratch, "Mod - Main.archive");
        var refusal = new ArchivePacker(new ModFolderRepository())
            .Pack(_scratch, "Mod - Main.archive", [.. files.Select(file => new ArchiveFile(file, _assets[file]))], variant);
        Assert.Null(refusal);
        return archive;
    }

    private ArchiveUnpackerTests With(string path, byte[] bytes)
    {
        _assets[path] = () => new MemoryStream(bytes);
        return this;
    }

    private static byte[] Read(ArchiveFile file)
    {
        using var content = file.Open();
        using var whole = new MemoryStream();
        content.CopyTo(whole);
        return whole.ToArray();
    }

    private static IReadOnlyList<ArchiveFile> Unpacked(GameRelease release, string archive, params string[] files)
    {
        Assert.Null(ArchiveUnpacker.Unpack(release, archive, files, out var unpacked));
        return unpacked;
    }

    private static ArchiveStepRefusal Refused(GameRelease release, string archive, params string[] files)
    {
        var refusal = ArchiveUnpacker.Unpack(release, archive, files, out var unpacked);
        Assert.Empty(unpacked);
        return Assert.IsType<ArchiveStepRefusal>(refusal);
    }

    [Fact]
    public void AGeneralBa2_UnpacksTheFilesItIsAskedForUnderThePathsAskedFor()
    {
        With(Meshes, Mesh).With(Scripts, Script);
        var archive = Packed(new Ba2Variant(1, Ba2Contents.General, Compressed: true), Meshes, Scripts);

        var files = Unpacked(GameRelease.Fallout4, archive, "scripts/a.pex");

        var unpacked = Assert.Single(files);
        Assert.Equal("scripts/a.pex", unpacked.Path);
        Assert.Equal(Script, Read(unpacked));
    }

    [Fact]
    public void ABsa_UnpacksAFileWhoseEntryIsSpelledInAnotherCase()
    {
        With(Meshes, Mesh);
        var archive = Packed(new BsaVariant(104, ArchiveFlags: 0x3, FileFlags: 0x3), Meshes);

        var files = Unpacked(GameRelease.SkyrimLE, archive, "MESHES/actors/A.NIF");

        Assert.Equal(Mesh, Read(Assert.Single(files)));
    }

    [Fact]
    public void ATexturesBa2_UnpacksADdsWhoseHeaderIsRebuiltAroundItsPixels()
    {
        var dds = Dds.Dxt1(width: 8, height: 8, mips: 2);
        With("textures/a_d.dds", dds.File);
        var archive = Packed(new Ba2Variant(1, Ba2Contents.Textures, Compressed: true), "textures/a_d.dds");

        var files = Unpacked(GameRelease.Fallout4, archive, "textures/a_d.dds");

        Assert.Equal(dds.Pixels, Read(Assert.Single(files))[^dds.Pixels.Length..]);
    }

    [Fact]
    public void ACompressedGeneralVersion2Ba2_UnpacksTheInflatedBytes()
    {
        With(Meshes, Mesh);
        var archive = Packed(new Ba2Variant(2, Ba2Contents.General, Compressed: true), Meshes);

        Assert.Equal(Mesh, Read(Assert.Single(Unpacked(GameRelease.Starfield, archive, Meshes))));
    }

    [Theory]
    [InlineData(7u)]
    [InlineData(8u)]
    public void ACompressedGeneralBa2OfAFallout4Version_UnpacksTheInflatedBytes(uint version)
    {
        With(Meshes, Mesh);
        var archive = Packed(new Ba2Variant(1, Ba2Contents.General, Compressed: true), Meshes);
        SetVersion(archive, version);

        Assert.Equal(Mesh, Read(Assert.Single(Unpacked(GameRelease.Fallout4, archive, Meshes))));
    }

    [Fact]
    public void AGeneralVersion3Ba2WhoseCompressionIsLz4_UnpacksTheInflatedBytes()
    {
        var archive = Path.Combine(_scratch, "Mod - Main.ba2");
        File.WriteAllBytes(archive, GeneralVersion3Lz4(Meshes, Mesh));

        Assert.Equal(Mesh, Read(Assert.Single(Unpacked(GameRelease.Starfield, archive, Meshes))));
    }

    [Fact]
    public void AZlibEntryThatInflatesPastItsRecordedSize_RefusesTheArchiveInsteadOfTruncatingTheFile()
    {
        With(Meshes, Mesh);
        var archive = Packed(new Ba2Variant(1, Ba2Contents.General, Compressed: true), Meshes);
        var bytes = File.ReadAllBytes(archive);
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(GeneralEntryAt + RecordedSizeAt), (uint)Mesh.Length - 1);
        File.WriteAllBytes(archive, bytes);

        var refusal = Refused(GameRelease.Fallout4, archive, Meshes);

        Assert.Equal(ArchiveRefusal.ArchiveUnreadable, refusal.Reason);
    }

    [Fact]
    public void ATextureOfADxgiFormatNoDdsHeaderIsWrittenFor_RefusesTheArchiveInsteadOfWritingAWrongHeader()
    {
        var unknown = Dds.Bc7(8, 8).File;
        BinaryPrimitives.WriteUInt32LittleEndian(unknown.AsSpan(128), 200);
        With("textures/odd.dds", unknown);
        var archive = Packed(new Ba2Variant(1, Ba2Contents.Textures, Compressed: false), "textures/odd.dds");

        var refusal = Refused(GameRelease.Fallout4, archive, "textures/odd.dds");

        Assert.Equal(ArchiveRefusal.ArchiveUnreadable, refusal.Reason);
        Assert.Contains("DXGI format 200", refusal.Message);
    }

    [Theory]
    [InlineData(2u)]
    [InlineData(3u)]
    public void ATexturesBa2OfVersion2And3_UnpacksTheInflatedPixels_TheLz4OneIncluded(uint version)
    {
        var dds = Dds.Dxt1(width: 16, height: 16, mips: 3);
        With("textures/a_d.dds", dds.File);
        var archive = Packed(new Ba2Variant(version, Ba2Contents.Textures, Compressed: true), "textures/a_d.dds");

        var files = Unpacked(GameRelease.Fallout4, archive, "textures/a_d.dds");

        Assert.Equal(dds.Pixels, Read(Assert.Single(files))[^dds.Pixels.Length..]);
    }

    [Fact]
    public void ATextureBa2_UnpacksADdsWhoseHeaderCarriesTheEntrysSizeMipsAndFormat()
    {
        With("textures/a_d.dds", Dds.Dxt1(width: 16, height: 8, mips: 3).File);
        With("textures/b_d.dds", Dds.Bc7(width: 8, height: 8).File);
        var archive = Packed(new Ba2Variant(1, Ba2Contents.Textures, Compressed: true), "textures/a_d.dds", "textures/b_d.dds");

        var files = Unpacked(GameRelease.Fallout4, archive, "textures/a_d.dds", "textures/b_d.dds");

        var dxt1 = Read(files[0]);
        Assert.Equal((8u, 16u, 3u, "DXT1"), (U32(dxt1, 12), U32(dxt1, 16), U32(dxt1, 28), Encoding.ASCII.GetString(dxt1, 84, 4)));
        var bc7 = Read(files[1]);
        Assert.Equal((8u, 8u, 1u, "DX10", 98u), (U32(bc7, 12), U32(bc7, 16), U32(bc7, 28), Encoding.ASCII.GetString(bc7, 84, 4), U32(bc7, 128)));
    }

    [Theory]
    [InlineData(1u, 1u)]
    [InlineData(2u, 2u)]
    [InlineData(3u, 3u)]
    [InlineData(1u, 7u)]
    [InlineData(1u, 8u)]
    public void ACubemapOfATexturesBa2_UnpacksWithTheCubeFlags(uint packedVersion, uint archiveVersion)
    {
        var cubemap = Dds.CubemapDxt1(8, 8);
        With("textures/Sky.dds", cubemap.File);
        var archive = Packed(new Ba2Variant(packedVersion, Ba2Contents.Textures, Compressed: true), "textures/Sky.dds");
        if (archiveVersion != packedVersion) SetVersion(archive, archiveVersion);

        var sky = Read(Assert.Single(Unpacked(GameRelease.Fallout4, archive, "textures/sky.dds")));

        Assert.Equal((0x8u | 0x1000u, 0xFE00u), (U32(sky, 108), U32(sky, 112)));
        Assert.Equal(cubemap.Pixels, sky[128..]);
    }

    [Fact]
    public void ADx10Cubemap_UnpacksWithTheCubeFlagOfItsExtension()
    {
        var cubemap = Dds.CubemapBc7(8, 8);
        With("textures/Sky.dds", cubemap.File);
        var archive = Packed(new Ba2Variant(1, Ba2Contents.Textures, Compressed: true), "textures/Sky.dds");

        var sky = Read(Assert.Single(Unpacked(GameRelease.Fallout4, archive, "textures/sky.dds")));

        Assert.Equal((0xFE00u, 4u, 1u), (U32(sky, 112), U32(sky, 136), U32(sky, 140)));
        Assert.Equal(cubemap.Pixels, sky[148..]);
    }

    [Fact]
    public void ATextureThatIsNoCubemap_UnpacksWithNoCubeCaps()
    {
        With("textures/flat.dds", Dds.Bc7(8, 8).File);
        var archive = Packed(new Ba2Variant(1, Ba2Contents.Textures, Compressed: true), "textures/flat.dds");

        var flat = Read(Assert.Single(Unpacked(GameRelease.Fallout4, archive, "textures/flat.dds")));

        Assert.Equal((0u, 0u), (U32(flat, 112), U32(flat, 136)));
    }

    [Fact]
    public void ABa2OfAVersionNoneReads_RefusesItAsUnreadable()
    {
        With(Meshes, Mesh);
        var archive = Packed(new Ba2Variant(1, Ba2Contents.General, Compressed: false), Meshes);
        SetVersion(archive, 4);

        var refusal = Refused(GameRelease.Fallout4, archive, Meshes);

        Assert.Equal(ArchiveRefusal.ArchiveUnreadable, refusal.Reason);
        Assert.Contains("version 4", refusal.Message);
    }

    private static byte[] GeneralVersion3Lz4(string path, byte[] content)
    {
        var block = new byte[LZ4Codec.MaximumOutputSize(content.Length)];
        var stored = LZ4Codec.Encode(content, block, LZ4Level.L09_HC);
        var entriesAt = HeaderLengthOfVersion3;
        var dataAt = entriesAt + GeneralEntryLength;
        using var archive = new MemoryStream();
        using var writer = new BinaryWriter(archive);
        writer.Write("BTDX"u8);
        writer.Write(3u);
        writer.Write("GNRL"u8);
        writer.Write(1u);
        writer.Write((ulong)(dataAt + stored));
        writer.Write(1ul);
        writer.Write(Lz4Compression);
        writer.Write(new byte[12]);
        writer.Write(0u);
        writer.Write((ulong)dataAt);
        writer.Write((uint)stored);
        writer.Write((uint)content.Length);
        writer.Write(0xBAADF00Du);
        writer.Write(block, 0, stored);
        var name = Encoding.UTF8.GetBytes(path);
        writer.Write((ushort)name.Length);
        writer.Write(name);
        return archive.ToArray();
    }

    private static uint U32(byte[] bytes, int at) => BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(at));

    private static void SetVersion(string archive, uint version)
    {
        var bytes = File.ReadAllBytes(archive);
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(4), version);
        File.WriteAllBytes(archive, bytes);
    }

    [Fact]
    public void AFileTheArchiveLacks_RefusesTheArchiveNamingIt()
    {
        With(Meshes, Mesh);
        var archive = Packed(new Ba2Variant(1, Ba2Contents.General, Compressed: false), Meshes);

        var refusal = Refused(GameRelease.Fallout4, archive, Meshes, "scripts/none.pex");

        Assert.Equal(ArchiveRefusal.FileNotInArchive, refusal.Reason);
        Assert.Contains("scripts/none.pex", refusal.Message);
    }

    [Fact]
    public void TwoEntriesThatNameOneFileWithoutRegardToCase_RefuseTheArchiveNamingBoth()
    {
        With("Meshes/A.nif", Mesh).With("meshes/a.nif", Script);
        var archive = Packed(new Ba2Variant(1, Ba2Contents.General, Compressed: false), "Meshes/A.nif", "meshes/a.nif");

        var refusal = Refused(GameRelease.Fallout4, archive, "meshes/a.nif");

        Assert.Equal(ArchiveRefusal.EntriesAmbiguous, refusal.Reason);
    }

    [Fact]
    public void AFileThatIsNoArchive_RefusesItAsUnreadable()
    {
        var notAnArchive = Path.Combine(_scratch, "Mod - Main.ba2");
        File.WriteAllText(notAnArchive, "this is not a BA2");

        var refusal = Refused(GameRelease.Fallout4, notAnArchive, Meshes);

        Assert.Equal(ArchiveRefusal.ArchiveUnreadable, refusal.Reason);
    }
}
