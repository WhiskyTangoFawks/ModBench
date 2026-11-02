using System.Buffers.Binary;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.ModFolderAdapter.Tests;

public sealed class Ba2CubemapsTests : IDisposable
{
    private const string Archive = "Mod - Textures.ba2";

    private readonly ScratchDirectory _scratch = new("ba2-cubemaps-");

    public void Dispose() => _scratch.Dispose();

    private string Textures(uint version, bool compressed)
    {
        var cube = Dds.Dxt1(8, 8, 1).File;
        BinaryPrimitives.WriteUInt32LittleEndian(cube.AsSpan(112), 0x200);
        Dictionary<string, byte[]> assets = new() { ["textures/flat.dds"] = Dds.Dxt1(8, 8, 1).File, ["textures/Sky.dds"] = cube };
        var refusal = new ArchivePacker(new ModFolderRepository()).Pack(
            _scratch, Archive, [.. assets.Select(asset => new ArchiveFile(asset.Key, () => new MemoryStream(asset.Value)))],
            new Ba2Variant(version, Ba2Contents.Textures, compressed));
        Assert.Null(refusal);
        return Path.Combine(_scratch, Archive);
    }

    private string TexturesOfVersion(uint version)
    {
        var archive = Textures(1, compressed: false);
        var bytes = File.ReadAllBytes(archive);
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(4), version);
        File.WriteAllBytes(archive, bytes);
        return archive;
    }

    private static ArchiveStepRefusal Unpacking(string archive, params string[] files) =>
        Assert.IsType<ArchiveStepRefusal>(ArchiveUnpacker.Unpack(GameRelease.Fallout4, archive, files, out _));

    [Theory]
    [InlineData(1u, false)]
    [InlineData(2u, true)]
    [InlineData(3u, true)]
    public void ATexturesBa2_RefusesItsCubemap(uint version, bool compressed)
    {
        var refusal = Unpacking(Textures(version, compressed), "textures/sky.dds");

        Assert.Equal(ArchiveRefusal.CubemapNotUnpackable, refusal.Reason);
    }

    [Theory]
    [InlineData(1u, false)]
    [InlineData(2u, true)]
    public void ATexturesBa2_UnpacksTheTextureBesideItsCubemap(uint version, bool compressed)
    {
        Assert.Null(ArchiveUnpacker.Unpack(GameRelease.Fallout4, Textures(version, compressed), ["textures/flat.dds"], out _));
    }

    [Theory]
    [InlineData(7u)]
    [InlineData(8u)]
    public void ATexturesBa2OfTheNextGenUpdate_RefusesItsCubemapAsFallout4sFirstVersionDoes(uint version)
    {
        var refusal = Unpacking(TexturesOfVersion(version), "textures/sky.dds");

        Assert.Equal(ArchiveRefusal.CubemapNotUnpackable, refusal.Reason);
    }

    [Fact]
    public void ATexturesBa2OfAVersionWhoseLayoutIsNotKnown_IsRefusedNamingTheVersion()
    {
        var refusal = Unpacking(TexturesOfVersion(4), "textures/flat.dds");

        Assert.Equal(ArchiveRefusal.ArchiveUnreadable, refusal.Reason);
        Assert.Contains("version 4", refusal.Message);
    }
}
