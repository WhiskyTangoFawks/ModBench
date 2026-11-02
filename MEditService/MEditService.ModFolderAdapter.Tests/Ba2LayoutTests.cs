using System.Buffers.Binary;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.ModFolderAdapter.Tests;

public sealed class Ba2LayoutTests : IDisposable
{
    private const string Archive = "Mod - Textures.ba2";

    private readonly ScratchDirectory _scratch = new("ba2-layout-");

    public static TheoryData<bool, uint, bool> VersionsNotShownToBeReadCorrectly => new()
    {
        { true, 2, false },
        { true, 3, false },
        { true, 4, true },
        { true, 7, true },
        { true, 8, true },
        { false, 3, true },
        { false, 4, true },
        { false, 7, true },
    };

    public void Dispose() => _scratch.Dispose();

    private string Packed(uint version, bool textures, bool versionPatched)
    {
        Dictionary<string, byte[]> assets = textures
            ? new() { ["textures/flat.dds"] = Dds.Dxt1(8, 8, 1).File, ["textures/Sky.dds"] = Dds.CubemapDxt1(8, 8).File }
            : new() { ["meshes/a.nif"] = [1, 2, 3] };
        var refusal = new ArchivePacker(new ModFolderRepository()).Pack(
            _scratch, Archive, [.. assets.Select(asset => new ArchiveFile(asset.Key, () => new MemoryStream(asset.Value)))],
            new Ba2Variant(versionPatched ? 1 : version, textures ? Ba2Contents.Textures : Ba2Contents.General, Compressed: version == 3 && !versionPatched));
        Assert.Null(refusal);
        var archive = Path.Combine(_scratch, Archive);
        if (versionPatched)
        {
            var bytes = File.ReadAllBytes(archive);
            BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(4), version);
            File.WriteAllBytes(archive, bytes);
        }
        return archive;
    }

    private static ArchiveStepRefusal Refused(string archive, string file) =>
        Assert.IsType<ArchiveStepRefusal>(ArchiveUnpacker.Unpack(GameRelease.Fallout4, archive, [file], out _));

    [Theory]
    [InlineData(1u, false)]
    [InlineData(2u, false)]
    [InlineData(3u, false)]
    [InlineData(7u, true)]
    [InlineData(8u, true)]
    public void ATexturesBa2_RefusesItsCubemap_NamingOnlyIt(uint version, bool versionPatched)
    {
        var archive = Packed(version, textures: true, versionPatched);

        var refusal = Assert.IsType<ArchiveStepRefusal>(ArchiveUnpacker.Unpack(GameRelease.Fallout4, archive, ["textures/flat.dds", "textures/sky.dds"], out _));

        Assert.Equal(ArchiveRefusal.CubemapNotUnpackable, refusal.Reason);
        Assert.Contains("textures/sky.dds", refusal.Message);
        Assert.DoesNotContain("textures/flat.dds", refusal.Message);
    }

    [Fact]
    public void ATexturesBa2_UnpacksTheTextureBesideItsCubemap()
    {
        Assert.Null(ArchiveUnpacker.Unpack(GameRelease.Fallout4, Packed(1, textures: true, versionPatched: false), ["textures/flat.dds"], out _));
    }

    [Theory]
    [MemberData(nameof(VersionsNotShownToBeReadCorrectly))]
    public void ABa2OfAVersionMutagenIsNotShownToReadCorrectly_IsRefusedAsUnreadable_NamingTheVersion(bool textures, uint version, bool versionPatched)
    {
        var refusal = Refused(Packed(version, textures, versionPatched), textures ? "textures/flat.dds" : "meshes/a.nif");

        Assert.Equal(ArchiveRefusal.ArchiveUnreadable, refusal.Reason);
        Assert.Contains($"version {version}", refusal.Message);
    }

    [Theory]
    [InlineData(2u, false)]
    [InlineData(8u, true)]
    public void AGeneralBa2OfAVersionMutagenReadsCorrectly_Unpacks(uint version, bool versionPatched)
    {
        Assert.Null(ArchiveUnpacker.Unpack(GameRelease.Fallout4, Packed(version, textures: false, versionPatched), ["meshes/a.nif"], out var unpacked));
        Assert.Single(unpacked);
    }
}
