using System.Buffers.Binary;
using MEditService.TestSupport;

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

    [Theory]
    [InlineData(1u, false)]
    [InlineData(2u, true)]
    [InlineData(3u, true)]
    public void ATexturesBa2_NamesItsCubemapsAmongItsTextures(uint version, bool compressed)
    {
        Assert.Equal(["textures/sky.dds"], Ba2Cubemaps.In(Textures(version, compressed)));
    }

    [Theory]
    [InlineData(7u)]
    [InlineData(8u)]
    public void ATexturesBa2OfTheNextGenUpdate_ReadsAsFallout4sFirstVersionDoes(uint version)
    {
        var archive = Textures(1, compressed: false);
        var bytes = File.ReadAllBytes(archive);
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(4), version);
        File.WriteAllBytes(archive, bytes);

        Assert.Equal(["textures/sky.dds"], Ba2Cubemaps.In(archive));
    }

    [Fact]
    public void ATexturesBa2OfAVersionWhoseLayoutIsNotKnown_IsRefusedNamingTheVersion()
    {
        var archive = Textures(1, compressed: false);
        var bytes = File.ReadAllBytes(archive);
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(4), 4);
        File.WriteAllBytes(archive, bytes);

        var refusal = ArchiveUnpacker.Unpack(Mutagen.Bethesda.GameRelease.Fallout4, archive, ["textures/flat.dds"], out var unpacked);

        Assert.Empty(unpacked);
        Assert.Equal(ArchiveRefusal.ArchiveUnreadable, Assert.IsType<ArchiveStepRefusal>(refusal).Reason);
        Assert.Contains("version 4", refusal.Message);
    }
}
